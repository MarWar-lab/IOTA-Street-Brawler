module street_brawler::arena {
    use iota::object::{Self, UID};
    use iota::coin::{Self, Coin};
    use iota::iota::IOTA;
    use iota::balance;
    use iota::transfer;
    use iota::tx_context::{Self, TxContext};
    use iota::clock::Clock;
    use std::option::{Self, Option};
    use street_brawler::player::{Self, Player};

    /// Shared global state.
    public struct ArenaState has key {
        id: UID,
        season: u64,
        matches_created: u64,
    }

    /// Publisher capability (owned by the package publisher; used for admin-only operations).
    public struct AdminCap has key {
        id: UID,
    }

    /// A shared match that holds escrowed stakes.
    public struct Match has key {
        id: UID,
        creator: address,
        joiner: Option<address>,

        stake_per_side: u64,
        stake_total: balance::Balance<IOTA>,

        // mutual-result settlement
        vote_creator: Option<address>,
        vote_joiner: Option<address>,

        settled: bool,
        winner: Option<address>,

        // each participant must claim once to receive progression/receipt
        claimed_creator: bool,
        claimed_joiner: bool,

        created_ms: u64,
    }

    /// Non-tradeable capability that lets each side submit their match result.
    public struct ResultCap has key {
        id: UID,
        match_addr: address,
        owner: address,
        side: u8, // 0=creator, 1=joiner
    }

    /// Tradeable receipt for indexers / season dashboards.
    public struct FightReceipt has key, store {
        id: UID,
        match_addr: address,
        winner: address,
        loser: address,
        stake_nanos: u64,
        ts_ms: u64,
    }

    const E_NOT_OPEN: u64 = 0;
    const E_ALREADY_JOINED: u64 = 1;
    const E_NOT_PARTICIPANT: u64 = 2;
    const E_BAD_VOTE: u64 = 3;
    const E_ALREADY_SETTLED: u64 = 4;
    const E_STAKE_MISMATCH: u64 = 5;
    const E_ONLY_CREATOR: u64 = 6;
    const E_ALREADY_CLAIMED: u64 = 7;
    const E_NOT_SETTLED: u64 = 8;

    /// init runs once at publish time.
    fun init(ctx: &mut TxContext) {
        let admin = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin, tx_context::sender(ctx));

        let st = ArenaState { id: object::new(ctx), season: 1, matches_created: 0 };
        transfer::share_object(st);
    }

    /// Create a new match and share it so other players can join.
    public entry fun create_match(arena: &mut ArenaState, player: &mut Player, stake: Coin<IOTA>, clock: &Clock, ctx: &mut TxContext) {
        assert!(player::owner(player) == tx_context::sender(ctx), E_NOT_PARTICIPANT);

        let creator = tx_context::sender(ctx);
        let created_ms = iota::clock::timestamp_ms(clock);
        arena.matches_created = arena.matches_created + 1;

        let stake_value = coin::value(&stake);
        let m = Match {
            id: object::new(ctx),
            creator,
            joiner: option::none(),
            stake_per_side: stake_value,
            stake_total: coin::into_balance(stake),
            vote_creator: option::none(),
            vote_joiner: option::none(),
            settled: false,
            winner: option::none(),
            claimed_creator: false,
            claimed_joiner: false,
            created_ms,
        };

        // Result cap for creator
        let cap = ResultCap { id: object::new(ctx), match_addr: object::id_address(&m), owner: creator, side: 0 };
        transfer::transfer(cap, creator);

        // Share the match so anyone can join.
        transfer::share_object(m);

        // Small SCASH reward for creating liquidity.
        player::grant_scash(player, 15);
    }

    /// Join a match by depositing an equal stake.
    public entry fun join_match(player: &mut Player, m: &mut Match, stake: Coin<IOTA>, ctx: &mut TxContext) {
        assert!(player::owner(player) == tx_context::sender(ctx), E_NOT_PARTICIPANT);
        assert!(!m.settled, E_ALREADY_SETTLED);
        assert!(option::is_none(&m.joiner), E_ALREADY_JOINED);

        let joiner = tx_context::sender(ctx);
        m.joiner = option::some(joiner);

        // Require equal stake.
        let b = coin::value(&stake);
        assert!(m.stake_per_side == b, E_STAKE_MISMATCH);

        // Merge stake into escrow balance.
        let bal = coin::into_balance(stake);
        balance::join(&mut m.stake_total, bal);

        // Result cap for joiner
        let cap = ResultCap { id: object::new(ctx), match_addr: object::id_address(m), owner: joiner, side: 1 };
        transfer::transfer(cap, joiner);

        player::grant_scash(player, 15);
    }

    /// Each side submits the same `winner` address. When both votes match, escrow settles.
    public entry fun submit_result(player: &mut Player, cap: ResultCap, m: &mut Match, winner: address, clock: &Clock, ctx: &mut TxContext) {
        assert!(player::owner(player) == tx_context::sender(ctx), E_NOT_PARTICIPANT);
        assert!(cap.owner == tx_context::sender(ctx), E_NOT_PARTICIPANT);
        assert!(cap.match_addr == object::id_address(m), E_BAD_VOTE);
        assert!(!m.settled, E_ALREADY_SETTLED);
        assert!(option::is_some(&m.joiner), E_NOT_OPEN);

        let j = *option::borrow(&m.joiner);
        assert!(winner == m.creator || winner == j, E_BAD_VOTE);

        if (cap.side == 0) {
            m.vote_creator = option::some(winner);
        } else {
            m.vote_joiner = option::some(winner);
        };

        // If both votes exist and match, finalize escrow.
        if (option::is_some(&m.vote_creator) && option::is_some(&m.vote_joiner)) {
            let vc = option::extract(&mut m.vote_creator);
            let vj = option::extract(&mut m.vote_joiner);
            assert!(vc == vj, E_BAD_VOTE);
            finalize(m, vc, clock, ctx);
        };

        // caps are single-use: delete
        let ResultCap { id, match_addr: _, owner: _, side: _ } = cap;
        object::delete(id);
    }

    /// Claim progression + receipt after settlement.
    /// Each participant must call this once.
    public entry fun claim_result(player: &mut Player, m: &mut Match, clock: &Clock, ctx: &mut TxContext) {
        assert!(player::owner(player) == tx_context::sender(ctx), E_NOT_PARTICIPANT);
        assert!(m.settled, E_NOT_SETTLED);
        assert!(option::is_some(&m.winner), E_NOT_SETTLED);
        assert!(option::is_some(&m.joiner), E_NOT_OPEN);

        let sender = tx_context::sender(ctx);
        let joiner = *option::borrow(&m.joiner);
        let is_creator = sender == m.creator;
        let is_joiner = sender == joiner;
        assert!(is_creator || is_joiner, E_NOT_PARTICIPANT);

        if (is_creator) {
            assert!(!m.claimed_creator, E_ALREADY_CLAIMED);
            m.claimed_creator = true;
        } else {
            assert!(!m.claimed_joiner, E_ALREADY_CLAIMED);
            m.claimed_joiner = true;
        };

        let w = *option::borrow(&m.winner);
        let won = sender == w;

        // Apply progression (bounded, deterministic)
        player::apply_match_result(player, won, 120, if (won) { 18 } else { -18 });
        player::grant_scash(player, if (won) { 120 } else { 40 });

        // Mint a tradeable receipt (per claimant)
        let now = iota::clock::timestamp_ms(clock);
        let loser = if (w == m.creator) { joiner } else { m.creator };
        let r = FightReceipt {
            id: object::new(ctx),
            match_addr: object::id_address(m),
            winner: w,
            loser,
            stake_nanos: m.stake_per_side,
            ts_ms: now,
        };
        transfer::transfer(r, sender);
    }

    /// Cancel an un-joined match (creator-only) and return the stake.
    public entry fun cancel_match(m: &mut Match, ctx: &mut TxContext) {
        assert!(m.creator == tx_context::sender(ctx), E_ONLY_CREATOR);
        assert!(option::is_none(&m.joiner), E_ALREADY_JOINED);
        assert!(!m.settled, E_ALREADY_SETTLED);
        m.settled = true;
        m.winner = option::none();

        let payout_bal = balance::withdraw_all(&mut m.stake_total);
        let payout_coin = coin::from_balance(payout_bal, ctx);
        transfer::public_transfer(payout_coin, m.creator);
    }

    fun finalize(m: &mut Match, winner: address, clock: &Clock, ctx: &mut TxContext) {
        assert!(!m.settled, E_ALREADY_SETTLED);
        m.settled = true;
        m.winner = option::some(winner);

        // Pay winner as a single coin derived from the escrowed Balance.
        let payout_bal = balance::withdraw_all(&mut m.stake_total);
        let payout_coin = coin::from_balance(payout_bal, ctx);
        transfer::public_transfer(payout_coin, winner);

        // mark time for transparency (optional)
        let _now = iota::clock::timestamp_ms(clock);
    }
}
