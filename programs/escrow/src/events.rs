use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub dispute_after_s: i64,
}

#[event]
pub struct DisputeWindowUpdated {
    pub dispute_after_s: i64,
}

#[event]
pub struct OrderListed {
    pub order: Pubkey,
    pub passport: Pubkey,
    pub seller: Pubkey,
    pub asset: Pubkey,
    pub price: u64,
    pub dispute_after_s: i64,
    pub ts: i64,
}

#[event]
pub struct AssetDeposited {
    pub order: Pubkey,
    pub asset: Pubkey,
    pub ts: i64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub seller: Pubkey,
    pub ts: i64,
}

#[event]
pub struct OrderClosed {
    pub order: Pubkey,
    pub seller: Pubkey,
    pub final_state: u8,
}

#[event]
pub struct OrderReserved {
    pub order: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub vault: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PreShipScanRecorded {
    pub order: Pubkey,
    pub scan_proof: Pubkey,
    pub counter: u32,
    pub ts: i64,
}

#[event]
pub struct OrderShipped {
    pub order: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReceiptScanRecorded {
    pub order: Pubkey,
    pub scan_proof: Pubkey,
    pub counter: u32,
    pub matched: bool,
    pub seller_fill: u8,
    pub buyer_fill: u8,
    pub seller_heat: u8,
    pub buyer_heat: u8,
    pub seller_hum: u8,
    pub buyer_hum: u8,
    pub ts: i64,
}

#[event]
pub struct OrderReleased {
    pub order: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub asset_transferred: bool,
    pub ts: i64,
}

#[event]
pub struct OrderDisputed {
    pub order: Pubkey,
    pub by: Pubkey,
    /// `DISPUTE_REASON_*`
    pub reason: u8,
    pub previous_state: u8,
    pub refunded: u64,
    pub asset_returned: bool,
    pub ts: i64,
}
