module street_brawler::player {
    use iota::object::{Self, UID};
    use iota::transfer;
    use iota::tx_context::{Self, TxContext};
    use iota::clock::Clock;
    use 0x8::random;
    use 0x8::random::Random;
    use std::option::{Self, Option};
    use std::string::{Self, String};

    /// Core player state (owned by the player's address).
    public struct Player has key {
        id: UID,
        owner: address,
        name: String,
        class_id: u8,

        // progression
        xp: u64,
        level: u64,
        wins: u64,
        losses: u64,
        elo: u64,

        // economy
        scash: u64,

        // anti-spam / pacing
        last_daily_ms: u64,
        daily_streak: u64,

        // daily action caps
        work_day: u64,
        work_count: u8,
        rob_day: u64,
        rob_count: u8,

        // equipment pointers (object IDs stored as addresses)
        equipped_weapon: Option<address>,
        equipped_offhand: Option<address>,
        equipped_skin: Option<address>,
    }

    /// Receipt object to make actions indexable.
    public struct ActionReceipt has key, store {
        id: UID,
        owner: address,
        kind: u8,
        amount: u64,
        ts_ms: u64,
    }

    const E_NOT_OWNER: u64 = 0;
    const E_ALREADY_CLAIMED: u64 = 1;
    const E_WORK_LIMIT: u64 = 2;
    const E_ROB_LIMIT: u64 = 3;
    const E_XP_TOO_HIGH: u64 = 20;
    const E_SCASH_TOO_HIGH: u64 = 21;

    const MS_PER_DAY: u64 = 86_400_000;

    /// Create a new player object and transfer to the sender.
    /// class_id: 0=brawler, 1=hustler, 2=schemer.
    public entry fun register(name: vector<u8>, class_id: u8, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let p = Player {
            id: object::new(ctx),
            owner: sender,
            name: string::utf8(name),
            class_id,
            xp: 0,
            level: 1,
            wins: 0,
            losses: 0,
            elo: 1200,
            scash: 0,
            last_daily_ms: 0,
            daily_streak: 0,
            work_day: 0,
            work_count: 0,
            rob_day: 0,
            rob_count: 0,
            equipped_weapon: option::none(),
            equipped_offhand: option::none(),
            equipped_skin: option::none(),
        };
        transfer::transfer(p, sender);
    }

    /// Equip helpers: store equipped object IDs on the Player.
    /// These functions intentionally take references to owned objects;
    /// if the sender can't provide the object, they can't equip it.
    public entry fun equip_weapon(player: &mut Player, weapon_id: address, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        player.equipped_weapon = option::some(weapon_id);
    }

    public entry fun equip_offhand(player: &mut Player, offhand_id: address, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        player.equipped_offhand = option::some(offhand_id);
    }

    public entry fun equip_skin(player: &mut Player, skin_id: address, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        player.equipped_skin = option::some(skin_id);
    }

    public fun equipped_weapon(player: &Player): Option<address> { player.equipped_weapon }
    public fun equipped_offhand(player: &Player): Option<address> { player.equipped_offhand }
    public fun equipped_skin(player: &Player): Option<address> { player.equipped_skin }

    /// Earn SCASH from an on-chain "work" action. Hard-capped to 8/day.
    public entry fun work(player: &mut Player, clock: &Clock, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        let now = iota::clock::timestamp_ms(clock);
        let day = now / MS_PER_DAY;

        if (player.work_day != day) {
            player.work_day = day;
            player.work_count = 0;
        };
        if (player.work_count >= 8) abort E_WORK_LIMIT;
        player.work_count = player.work_count + 1;

        // payout scales slightly with level
        let payout = 45 + (player.level * 3);
        player.scash = player.scash + payout;

        let receipt = ActionReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind: 2, // work
            amount: payout,
            ts_ms: now,
        };
        transfer::transfer(receipt, tx_context::sender(ctx));
    }

    /// Attempt a robbery using the on-chain Random singleton. Hard-capped to 3/day.
    /// `bonus` is caller-provided bonus (0..95) from future on-chain skills.
    public entry fun attempt_robbery(player: &mut Player, r: &Random, clock: &Clock, bonus: u8, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        let now = iota::clock::timestamp_ms(clock);
        let day = now / MS_PER_DAY;

        if (player.rob_day != day) {
            player.rob_day = day;
            player.rob_count = 0;
        };
        if (player.rob_count >= 3) abort E_ROB_LIMIT;
        player.rob_count = player.rob_count + 1;

        // success chance: base 60% + bonus, capped at 95%
        let mut chance: u64 = 60 + (bonus as u64);
        if (chance > 95) chance = 95;

        let mut g = random::new_generator(r, ctx);
        let roll = random::generate_u8_in_range(&mut g, 1, 100) as u64;

        let success = roll <= chance;
        let payout = if (success) {
            // 150..400 inclusive
            (random::generate_u8_in_range(&mut g, 0, 250) as u64) + 150
        } else { 0 };

        if (success) player.scash = player.scash + payout;

        let receipt = ActionReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind: if (success) { 3 } else { 4 }, // rob_success / rob_fail
            amount: payout,
            ts_ms: now,
        };
        transfer::transfer(receipt, tx_context::sender(ctx));
    }

    /// Daily claim mints SCASH and an on-chain receipt.
    public entry fun claim_daily(player: &mut Player, clock: &Clock, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        let now = iota::clock::timestamp_ms(clock);
        if (player.last_daily_ms != 0 && now < player.last_daily_ms + MS_PER_DAY) {
            abort E_ALREADY_CLAIMED;
        };

        // streak window: 1.5d
        if (player.last_daily_ms != 0 && now <= player.last_daily_ms + (MS_PER_DAY * 3 / 2)) {
            player.daily_streak = player.daily_streak + 1;
        } else {
            player.daily_streak = 1;
        };
        player.last_daily_ms = now;

        // payout increases with streak, capped.
        let bonus = if (player.daily_streak > 10) { 10 } else { player.daily_streak };
        let payout = 100 + (bonus * 25);
        player.scash = player.scash + payout;

        let receipt = ActionReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind: 1, // daily
            amount: payout,
            ts_ms: now,
        };
        transfer::transfer(receipt, tx_context::sender(ctx));
    }

    /// Spend SCASH and mint an ActionReceipt.
    /// Used by food / sleep / other micro-actions.
    public entry fun spend_scash_action(player: &mut Player, amount: u64, kind: u8, clock: &Clock, ctx: &mut TxContext) {
        assert_owner(player, ctx);
        if (amount > 0) {
            spend_scash(player, amount);
        };
        let now = iota::clock::timestamp_ms(clock);
        let receipt = ActionReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind,
            amount,
            ts_ms: now,
        };
        transfer::transfer(receipt, tx_context::sender(ctx));
    }

    /// Record a ranked fight result (off-chain fight, on-chain commit).
    /// Enforces strict caps so clients can't inflate XP/SCASH.
    public entry fun record_ranked(
        player: &mut Player,
        opponent_elo: u64,
        won: bool,
        xp_gain: u64,
        scash_reward: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert_owner(player, ctx);
        if (xp_gain > 400) abort E_XP_TOO_HIGH;
        if (scash_reward > 250) abort E_SCASH_TOO_HIGH;

        let now = iota::clock::timestamp_ms(clock);

        // Simple ELO delta heuristic (bounded).
        let mut d: i64 = 18;
        if (opponent_elo + 200 < player.elo) { d = 12; };
        if (opponent_elo > player.elo + 200) { d = 24; };
        let elo_delta = if (won) { d } else { 0 - d };

        apply_match_result(player, won, xp_gain, elo_delta);
        grant_scash(player, scash_reward);

        let receipt = ActionReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind: if (won) { 11 } else { 12 }, // ranked_win / ranked_loss
            amount: scash_reward,
            ts_ms: now,
        };
        transfer::transfer(receipt, tx_context::sender(ctx));
    }

    /// Internal: grant SCASH.
    public fun grant_scash(player: &mut Player, amount: u64) {
        player.scash = player.scash + amount;
    }

    /// Internal: spend SCASH.
    public fun spend_scash(player: &mut Player, amount: u64) {
        if (player.scash < amount) abort 10;
        player.scash = player.scash - amount;
    }

    /// Internal: apply match result.
    public fun apply_match_result(player: &mut Player, won: bool, xp_gain: u64, elo_delta: i64) {
        if (won) player.wins = player.wins + 1 else player.losses = player.losses + 1;
        player.xp = player.xp + xp_gain;

        // every 150 xp = +1 level
        let new_level = (player.xp / 150) + 1;
        if (new_level > player.level) player.level = new_level;

        if (elo_delta < 0) {
            let d = (0 - elo_delta) as u64;
            if (player.elo > d) player.elo = player.elo - d else player.elo = 800;
        } else {
            player.elo = player.elo + (elo_delta as u64);
        };
    }

    /// Accessors
    public fun owner(player: &Player): address { player.owner }
    public fun scash(player: &Player): u64 { player.scash }
    public fun level(player: &Player): u64 { player.level }
    public fun elo(player: &Player): u64 { player.elo }

    fun assert_owner(player: &Player, ctx: &TxContext) {
        if (player.owner != tx_context::sender(ctx)) abort E_NOT_OWNER;
    }
}
