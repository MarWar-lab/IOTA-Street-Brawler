module street_brawler::market {
    use iota::object::{Self, UID};
    use iota::transfer;
    use iota::tx_context::{Self, TxContext};
    use iota::coin::{Self, Coin};
    use iota::iota::IOTA;
    use street_brawler::items::{Self, Weapon};

    /// Shared market state (tracks counts / future upgrades).
    public struct MarketState has key {
        id: UID,
        listings_created: u64,
        listings_active: u64,
    }

    /// Each listing is a shared object. It escrows the Weapon until bought/canceled.
    public struct Listing has key {
        id: UID,
        seller: address,
        price_nanos: u64,
        weapon: Weapon,
        active: bool,
    }

    const E_NOT_SELLER: u64 = 0;
    const E_NOT_ACTIVE: u64 = 1;

    public entry fun init_market(ctx: &mut TxContext) {
        let st = MarketState { id: object::new(ctx), listings_created: 0, listings_active: 0 };
        transfer::share_object(st);
    }

    /// List a weapon for sale.
    public entry fun list_weapon(state: &mut MarketState, weapon: Weapon, price_nanos: u64, ctx: &mut TxContext) {
        state.listings_created = state.listings_created + 1;
        state.listings_active = state.listings_active + 1;

        let l = Listing {
            id: object::new(ctx),
            seller: tx_context::sender(ctx),
            price_nanos,
            weapon,
            active: true,
        };

        transfer::share_object(l);
    }

    /// Cancel your listing and receive the weapon back.
    public entry fun cancel_listing(state: &mut MarketState, l: &mut Listing, ctx: &mut TxContext) {
        if (!l.active) abort E_NOT_ACTIVE;
        if (l.seller != tx_context::sender(ctx)) abort E_NOT_SELLER;

        l.active = false;
        state.listings_active = state.listings_active - 1;

        let Listing { id, seller: _, price_nanos: _, weapon, active: _ } = l;
        // return weapon
        transfer::transfer(weapon, tx_context::sender(ctx));
        object::delete(id);
    }

    /// Buy a weapon by paying IOTA coin.
    public entry fun buy_weapon(state: &mut MarketState, l: &mut Listing, mut payment: Coin<IOTA>, ctx: &mut TxContext) {
        if (!l.active) abort E_NOT_ACTIVE;

        let price = l.price_nanos;
        let paid = coin::value(&payment);
        // Require exact payment for simplicity.
        assert!(paid == price, 10);

        l.active = false;
        state.listings_active = state.listings_active - 1;

        // pay seller
        transfer::public_transfer(payment, l.seller);

        let Listing { id, seller: _, price_nanos: _, weapon, active: _ } = l;
        // deliver weapon to buyer
        transfer::transfer(weapon, tx_context::sender(ctx));
        object::delete(id);
    }

    /// View helpers
    public fun listing_price(l: &Listing): u64 { l.price_nanos }
    public fun listing_seller(l: &Listing): address { l.seller }
    public fun listing_active(l: &Listing): bool { l.active }
    public fun listing_weapon_kind(l: &Listing): u8 { items::weapon_kind(&l.weapon) }
    public fun listing_weapon_level(l: &Listing): u8 { items::weapon_level(&l.weapon) }
}
