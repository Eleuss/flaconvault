use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Order is not in the required state for this instruction")]
    InvalidState,
    #[msg("price must be > 0")]
    InvalidPrice,
    #[msg("dispute_after_s must be between MIN_DISPUTE_AFTER_S (1 h) and MAX_DISPUTE_AFTER_S (60 days)")]
    InvalidDisputeWindow,
    #[msg("Passport is void")]
    PassportVoid,
    #[msg("Signer is not the order's seller")]
    NotSeller,
    #[msg("Signer is not the order's buyer")]
    NotBuyer,
    #[msg("Seller cannot buy their own listing")]
    SellerCannotBuy,
    #[msg("Signer is neither the escrow admin nor an entitled party")]
    Unauthorized,
    #[msg("Token account mint does not match the escrow USDC mint")]
    WrongMint,
    #[msg("ScanProof does not belong to the given seal")]
    ScanSealMismatch,
    #[msg("Seal does not belong to the order's passport")]
    SealPassportMismatch,
    #[msg("ScanProof attester is not the expected party")]
    ScanAttesterMismatch,
    #[msg("Given seller ScanProof is not the one recorded on the order")]
    SellerScanMismatch,
    #[msg("Receipt scan on the same seal must have a higher counter than the pre-ship scan")]
    ReceiptScanNotNewer,
    #[msg("Dispute window after shipping has not elapsed yet")]
    DisputeWindowNotElapsed,
    #[msg("Seal is not dead")]
    SealNotDead,
    #[msg("Asset account does not match the order's asset")]
    AssetMismatch,
    #[msg("Asset already deposited")]
    AssetAlreadyDeposited,
    #[msg("Asset custody requires the asset and mpl-core program accounts")]
    MissingAssetAccounts,
    #[msg("Not the Metaplex Core program")]
    InvalidCoreProgram,
    #[msg("Asset account is not owned by Metaplex Core")]
    InvalidAsset,
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // ---- appended (keep the codes above stable) ----
    #[msg("The order's price differs from the price the buyer agreed to")]
    PriceChanged,
    #[msg("Seller is not the owner of the passport's Core asset (or, without a Core asset, its issuer)")]
    NotPassportOwner,
    #[msg("The receipt scan matched the shipping scan: release the order instead of disputing it")]
    ReceiptMatched,
    #[msg("Token account does not belong to the expected recipient")]
    WrongTokenOwner,
}
