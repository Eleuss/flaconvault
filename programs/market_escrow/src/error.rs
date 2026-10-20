use anchor_lang::prelude::*;

#[error_code]
pub enum MarketEscrowError {
    // ---- config ----
    #[msg("Only the program's upgrade authority may create the config")]
    NotUpgradeAuthority,
    #[msg("Key must not be the default pubkey")]
    InvalidKey,
    #[msg("The offer key and the arbiter must be different keys")]
    OfferKeyIsArbiter,
    #[msg("Mint must be a classic SPL Token mint with 6 decimals")]
    InvalidMint,
    #[msg("USDC and EURC must be two different mints")]
    DuplicateMint,
    #[msg("Mint is not allowed by the config")]
    MintNotAllowed,

    // ---- signed offer ----
    #[msg("Not the instructions sysvar")]
    InvalidInstructionsSysvar,
    #[msg("open_and_deposit must directly follow an Ed25519 instruction with the signed offer")]
    MissingOfferSignature,
    #[msg("Malformed Ed25519 instruction (one signature, data in the instruction itself, 201-byte offer)")]
    MalformedEd25519Instruction,
    #[msg("The offer is not signed by the config's offer key")]
    OfferKeyMismatch,
    #[msg("The signed offer differs from the order terms, the buyer, the mint or this program")]
    OfferMismatch,
    #[msg("The signed offer has expired")]
    OfferExpired,
    #[msg("The offer expiry lies more than MAX_OFFER_TTL_S in the future")]
    OfferExpiryTooFar,

    // ---- order terms ----
    #[msg("amount must be > 0 and amount + buyer_fee must fit in u64")]
    InvalidAmount,
    #[msg("buyer_fee and seller_fee may each be at most MAX_FEE_BPS of amount")]
    FeeTooHigh,
    #[msg("Unknown lane")]
    InvalidLane,
    #[msg("Lane G is not available with crypto payment")]
    LaneNotSupported,
    #[msg("ship_deadline must lie MIN_SHIP_WINDOW_S ..= MAX_SHIP_WINDOW_S after now")]
    InvalidShipDeadline,
    #[msg("ruling_window_s must be within MIN_RULING_WINDOW_S ..= MAX_RULING_WINDOW_S")]
    InvalidRulingWindow,
    #[msg("timelock_s must be within MIN_TIMELOCK_S ..= MAX_TIMELOCK_S")]
    InvalidTimelock,
    #[msg("Seller must be a wallet other than the buyer and the arbiter")]
    InvalidSeller,
    #[msg("The buyer must not be the arbiter")]
    BuyerIsArbiter,
    #[msg("An order with this id already exists for this buyer")]
    OrderAlreadyExists,

    // ---- order flow ----
    #[msg("Order is not in the required state for this instruction")]
    InvalidState,
    #[msg("Signer is not the order's buyer")]
    NotBuyer,
    #[msg("Signer is not the order's seller")]
    NotSeller,
    #[msg("Signer is not the arbiter")]
    NotArbiter,
    #[msg("Signer is not entitled to this instruction on this order")]
    NotParty,
    #[msg("The ship deadline has passed: the order can only be refunded")]
    ShipDeadlinePassed,
    #[msg("The ship deadline has not passed yet")]
    ShipDeadlineNotPassed,
    #[msg("The review window after shipping is still open")]
    ReviewWindowOpen,
    #[msg("The review window after shipping has closed")]
    ReviewWindowClosed,
    #[msg("T_max has passed without a ruling: the order can only be refunded")]
    RulingDeadlinePassed,
    #[msg("T_max has not passed yet")]
    RulingDeadlineNotPassed,
    #[msg("The ruling's timelock is still running")]
    TimelockActive,
    #[msg("A ruling is RULING_RELEASE or RULING_REFUND")]
    InvalidRuling,
    #[msg("A ruling must publish a non-zero reason hash")]
    MissingReasonHash,
    #[msg("No settlement proposal is open")]
    NoProposal,
    #[msg("The proposal differs from the amount the signer agreed to")]
    ProposalMismatch,
    #[msg("A party cannot accept its own proposal")]
    OwnProposal,
    #[msg("A settlement cannot give the buyer more than the deposit")]
    SettlementTooLarge,
    #[msg("The token account for this payout is missing")]
    MissingTokenAccount,
    #[msg("The order can be closed only after the offer expired")]
    OfferNotExpired,
    #[msg("Not the account that paid the order's rent")]
    RentPayerMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
