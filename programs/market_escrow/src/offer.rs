//! The order terms FlaconVault signs with its offer key, and the exact bytes of that signature.
//!
//! `open_and_deposit` must directly follow an Ed25519 precompile instruction whose public key is
//! `config.offer_key` and whose message equals `offer_message(program id, buyer, mint, args)` byte for
//! byte. The key only fixes terms: it signs nothing the program would execute on its own, and the buyer
//! still signs (and funds) the deposit.
//!
//! Message (201 bytes, integers little endian):
//! ```text
//! @0   8   "FVMKTOF1"
//! @8   32  program id (no replay against another deployment)
//! @40  16  order_id
//! @56  32  buyer
//! @88  32  seller (the seller's own wallet)
//! @120 32  mint (USDC or EURC)
//! @152 8   amount        u64 (item price, base units)
//! @160 8   buyer_fee     u64 (buyer protection, on top of amount)
//! @168 8   seller_fee    u64 (commission, deducted from amount on release)
//! @176 1   lane          u8  (LANE_S / LANE_A)
//! @177 8   ship_deadline i64 (unix s)
//! @185 4   ruling_window_s u32 (T_max after the dispute)
//! @189 4   timelock_s    u32 (after the ruling)
//! @193 8   expiry        i64 (unix s, offer valid until)
//! ```

use anchor_lang::prelude::*;

use crate::constants::{OFFER_MSG_LEN, OFFER_PREFIX};

pub const OFFER_LEN: usize = OFFER_MSG_LEN as usize;

/// Order terms as signed by the offer key (buyer and mint come from the accounts).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct OfferArgs {
    /// 16 random bytes chosen by the server; part of the order PDA seeds.
    pub order_id: [u8; 16],
    pub seller: Pubkey,
    pub amount: u64,
    pub buyer_fee: u64,
    pub seller_fee: u64,
    pub lane: u8,
    pub ship_deadline: i64,
    pub ruling_window_s: u32,
    pub timelock_s: u32,
    pub expiry: i64,
}

pub fn offer_message(program_id: &Pubkey, buyer: &Pubkey, mint: &Pubkey, a: &OfferArgs) -> [u8; OFFER_LEN] {
    let mut m = [0u8; OFFER_LEN];
    let mut at = 0usize;
    let mut put = |bytes: &[u8]| {
        m[at..at + bytes.len()].copy_from_slice(bytes);
        at += bytes.len();
    };
    put(OFFER_PREFIX);
    put(program_id.as_ref());
    put(&a.order_id);
    put(buyer.as_ref());
    put(a.seller.as_ref());
    put(mint.as_ref());
    put(&a.amount.to_le_bytes());
    put(&a.buyer_fee.to_le_bytes());
    put(&a.seller_fee.to_le_bytes());
    put(&[a.lane]);
    put(&a.ship_deadline.to_le_bytes());
    put(&a.ruling_window_s.to_le_bytes());
    put(&a.timelock_s.to_le_bytes());
    put(&a.expiry.to_le_bytes());
    debug_assert_eq!(at, OFFER_LEN);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> (Pubkey, Pubkey, Pubkey, OfferArgs) {
        let program_id = Pubkey::new_from_array([1u8; 32]);
        let buyer = Pubkey::new_from_array([2u8; 32]);
        let mint = Pubkey::new_from_array([4u8; 32]);
        let args = OfferArgs {
            order_id: [0xA5; 16],
            seller: Pubkey::new_from_array([3u8; 32]),
            amount: 300_000_000,
            buyer_fee: 15_000_000,
            seller_fee: 9_000_000,
            lane: crate::constants::LANE_S,
            ship_deadline: 1_790_000_000,
            ruling_window_s: 21 * 86_400,
            timelock_s: 48 * 3_600,
            expiry: 1_789_000_600,
        };
        (program_id, buyer, mint, args)
    }

    #[test]
    fn layout_offsets() {
        let (p, b, mint, a) = sample();
        let m = offer_message(&p, &b, &mint, &a);
        assert_eq!(m.len(), 201);
        assert_eq!(&m[0..8], b"FVMKTOF1");
        assert_eq!(&m[8..40], p.as_ref());
        assert_eq!(&m[40..56], &a.order_id);
        assert_eq!(&m[56..88], b.as_ref());
        assert_eq!(&m[88..120], a.seller.as_ref());
        assert_eq!(&m[120..152], mint.as_ref());
        assert_eq!(u64::from_le_bytes(m[152..160].try_into().unwrap()), a.amount);
        assert_eq!(u64::from_le_bytes(m[160..168].try_into().unwrap()), a.buyer_fee);
        assert_eq!(u64::from_le_bytes(m[168..176].try_into().unwrap()), a.seller_fee);
        assert_eq!(m[176], a.lane);
        assert_eq!(i64::from_le_bytes(m[177..185].try_into().unwrap()), a.ship_deadline);
        assert_eq!(u32::from_le_bytes(m[185..189].try_into().unwrap()), a.ruling_window_s);
        assert_eq!(u32::from_le_bytes(m[189..193].try_into().unwrap()), a.timelock_s);
        assert_eq!(i64::from_le_bytes(m[193..201].try_into().unwrap()), a.expiry);
    }

    /// The same vector is built by the TypeScript builder (tests/lib/market-escrow.ts, asserted in
    /// tests/market-escrow.ts) and documented in docs/market-escrow.md for the server.
    #[test]
    fn golden_vector() {
        let (p, b, mint, a) = sample();
        let m = offer_message(&p, &b, &mint, &a);
        let hex: String = m.iter().map(|x| format!("{x:02x}")).collect();
        assert_eq!(hex, GOLDEN_HEX);
    }

    pub(crate) const GOLDEN_HEX: &str = concat!(
        "46564d4b544f4631",
        "0101010101010101010101010101010101010101010101010101010101010101",
        "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5",
        "0202020202020202020202020202020202020202020202020202020202020202",
        "0303030303030303030303030303030303030303030303030303030303030303",
        "0404040404040404040404040404040404040404040404040404040404040404",
        "00a3e11100000000",
        "c0e1e40000000000",
        "4054890000000000",
        "01",
        "803bb16a00000000",
        "80af1b00",
        "00a30200",
        "98fba16a00000000",
    );

    #[test]
    fn every_field_changes_the_message() {
        let (p, b, mint, a) = sample();
        let base = offer_message(&p, &b, &mint, &a);
        let other = Pubkey::new_from_array([9u8; 32]);
        let variants: Vec<[u8; OFFER_LEN]> = vec![
            offer_message(&other, &b, &mint, &a),
            offer_message(&p, &other, &mint, &a),
            offer_message(&p, &b, &other, &a),
            offer_message(&p, &b, &mint, &OfferArgs { order_id: [0; 16], ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { seller: other, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { amount: a.amount + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { buyer_fee: a.buyer_fee + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { seller_fee: a.seller_fee + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { lane: crate::constants::LANE_A, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { ship_deadline: a.ship_deadline + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { ruling_window_s: a.ruling_window_s + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { timelock_s: a.timelock_s + 1, ..a.clone() }),
            offer_message(&p, &b, &mint, &OfferArgs { expiry: a.expiry + 1, ..a.clone() }),
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_ne!(v, &base, "variant {i} did not change the message");
        }
    }
}
