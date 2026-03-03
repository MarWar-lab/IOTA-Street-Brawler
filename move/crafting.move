module street_brawler::crafting {
    use iota::tx_context::TxContext;
    use street_brawler::player::{Self, Player};
    use street_brawler::items::{Self, Weapon, Offhand};

    const E_MAX_LEVEL: u64 = 0;

    /// Upgrade weapon up to level 50.
    /// Cost ramps superlinearly so Lv50 is a long grind.
    public entry fun upgrade_weapon(player: &mut Player, weapon: &mut Weapon, ctx: &mut TxContext) {
        let _ = ctx;
        let lvl = items::weapon_level(weapon);
        if (lvl >= 50) abort E_MAX_LEVEL;

        // next level
        let next = (lvl as u64) + 1;

        // months-long curve (tune freely): 250 * next^2
        let cost = 250 * next * next;
        player::spend_scash(player, cost);

        items::inc_weapon_level(weapon);

        // stats: atk every level; def every 3 levels
        items::add_weapon_stats(weapon, 1, if ((next % 3) == 0) { 1 } else { 0 });

        // extra grind rewards: small XP bump at higher tiers (optional)
        if (next == 10 || next == 20 || next == 30 || next == 40 || next == 50) {
            // reward the grind with SCASH back (tiny rebate)
            player::grant_scash(player, 100 + (next * 10));
        };
    }

    public entry fun upgrade_offhand(player: &mut Player, offhand: &mut Offhand, ctx: &mut TxContext) {
        let _ = ctx;
        let lvl = items::offhand_level(offhand);
        if (lvl >= 50) abort E_MAX_LEVEL;

        let next = (lvl as u64) + 1;
        let cost = 220 * next * next;
        player::spend_scash(player, cost);

        items::inc_offhand_level(offhand);
        // def-focused
        items::add_offhand_stats(offhand, 0, 1 + if ((next % 5) == 0) { 1 } else { 0 });
    }
}
