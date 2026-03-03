module street_brawler::items {
    use iota::object::{Self, UID};
    use iota::transfer;
    use iota::tx_context::{Self, TxContext};
    use street_brawler::player::{Self, Player};

    /// Tradeable equipment objects.
    ///
    /// Note: having `store` enables public transfers and compatibility with commerce standards.
    public struct Weapon has key, store {
        id: UID,
        owner: address,
        kind: u8,
        atk: u8,
        def: u8,
    }

    public struct Offhand has key, store {
        id: UID,
        owner: address,
        kind: u8,
        atk: u8,
        def: u8,
    }

    public struct Skin has key, store {
        id: UID,
        owner: address,
        skin_id: u16,
    }

    const E_BAD_KIND: u64 = 0;

    /// Buy a weapon using SCASH (increments on-chain activity and creates a real owned asset).
    /// kind: 0=bat, 1=knife, 2=chain, 3=brass
    public entry fun buy_weapon(player: &mut Player, kind: u8, ctx: &mut TxContext) {
        // pricing tuned for micro-actions
        let (price, atk, def) = weapon_stats(kind);
        player::spend_scash(player, price);

        let wpn = Weapon {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind,
            atk,
            def,
        };
        transfer::transfer(wpn, tx_context::sender(ctx));
    }

    /// Buy an offhand (shield/armor) using SCASH.
    /// kind: 0=shield, 1=armor
    public entry fun buy_offhand(player: &mut Player, kind: u8, ctx: &mut TxContext) {
        let (price, atk, def) = offhand_stats(kind);
        player::spend_scash(player, price);

        let it = Offhand {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            kind,
            atk,
            def,
        };
        transfer::transfer(it, tx_context::sender(ctx));
    }

    /// Buy a cosmetic skin using SCASH.
    public entry fun buy_skin(player: &mut Player, skin_id: u16, ctx: &mut TxContext) {
        // cheap cosmetics: high frequency txs
        let price = 120;
        player::spend_scash(player, price);

        let s = Skin {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            skin_id,
        };
        transfer::transfer(s, tx_context::sender(ctx));
    }

    /// Pure helper: weapon pricing + stats.
    fun weapon_stats(kind: u8): (u64, u8, u8) {
        if (kind == 0) return (300, 3, 0);
        if (kind == 1) return (500, 5, 0);
        if (kind == 2) return (450, 4, 1);
        if (kind == 3) return (650, 6, 0);
        abort E_BAD_KIND;
    }

    fun offhand_stats(kind: u8): (u64, u8, u8) {
        if (kind == 0) return (400, 0, 4);
        if (kind == 1) return (700, 0, 6);
        abort E_BAD_KIND;
    }
}
