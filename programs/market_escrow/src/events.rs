use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub offer_key: Pubkey,
    pub arbiter: Pubkey,
    pub fee_recipient: Pubkey,
    pub mints: [Pubkey; 2],
}

#[event]
pub struct OrderOpened {
    pub order: Pubkey,
    pub order_id: [u8; 16],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub buyer_fee: u64,
    pub seller_fee: u64,
    pub lane: u8,
    pub ship_deadline: i64,
    pub rent_payer: Pubkey,
    pub ts: i64,
}

#[event]
pub struct OrderShipped {
    pub order: Pubkey,
    pub review_until: i64,
    pub ts: i64,
}

/// The seller was paid (`to_seller`) and the fees went to the fee vault (`fees`).
#[event]
pub struct OrderReleased {
    pub order: Pubkey,
    pub resolution: u8,
    pub to_seller: u64,
    pub fees: u64,
    pub ts: i64,
}

/// The buyer got the whole deposit back.
#[event]
pub struct OrderRefunded {
    pub order: Pubkey,
    pub resolution: u8,
    pub to_buyer: u64,
    pub ts: i64,
}

#[event]
pub struct OrderDisputed {
    pub order: Pubkey,
    pub by: u8,
    pub ruling_deadline: i64,
    pub ts: i64,
}

#[event]
pub struct SettlementProposed {
    pub order: Pubkey,
    pub by: u8,
    pub to_buyer: u64,
    pub to_seller: u64,
    pub ts: i64,
}

#[event]
pub struct OrderSettled {
    pub order: Pubkey,
    pub to_buyer: u64,
    pub to_seller: u64,
    pub ts: i64,
}

#[event]
pub struct RulingMade {
    pub order: Pubkey,
    pub ruling: u8,
    pub reason_hash: [u8; 32],
    pub executable_after: i64,
    pub ts: i64,
}

#[event]
pub struct FeesCollected {
    pub mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub ts: i64,
}

#[event]
pub struct OrderClosed {
    pub order: Pubkey,
    pub rent_payer: Pubkey,
    pub swept_to_buyer: u64,
    pub ts: i64,
}
