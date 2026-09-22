//! EIP-712 typed-data signing, narrowed to exactly one message: EIP-3009
//! `TransferWithAuthorization`.
//!
//! This is what the x402 `exact` scheme signs on EVM. The payer signs an authorization
//! naming the recipient, the amount and a validity window; the facilitator submits
//! `transferWithAuthorization` and pays the gas. The facilitator cannot alter the amount
//! or the destination — it can only broadcast or not.
//!
//! **Why this is not a generic `sign_hash` command.** A command that signs any 32 bytes
//! handed to it is a blank cheque: the renderer would decide what the participant's key
//! attests to, and Rust would have no way to tell a payment authorization from a
//! transaction, a login challenge, or a contract-owning delegation. So the digest is
//! built *here*, from named fields of one struct, and nothing else can be signed through
//! this door. The frontend supplies values; Rust decides what they mean.
//!
//! Spec: EIP-712 (typed structured data), EIP-3009 (transfer with authorization),
//! `specs/schemes/exact/scheme_exact_evm.md` in algorandfoundation/x402.

use k256::ecdsa::signature::hazmat::PrehashSigner;
use k256::ecdsa::{RecoveryId, Signature};
use serde::Deserialize;

use super::sign::{keccak256, signing_key};

/// `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
const DOMAIN_TYPEHASH: [u8; 32] =
    hex_literal_32("8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f");

/// `keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`
const TRANSFER_TYPEHASH: [u8; 32] =
    hex_literal_32("7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");

/// Decode a 64-character hex literal at compile time.
const fn hex_literal_32(s: &str) -> [u8; 32] {
    let bytes = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = hex_nibble(bytes[i * 2]) * 16 + hex_nibble(bytes[i * 2 + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

/// The EIP-712 domain of the token being spent. For USDC, `name` and `version` come from
/// the 402 challenge's `extra`, and `verifying_contract` is the requirement's `asset`.
#[derive(Debug, Clone, Deserialize)]
pub struct Eip712Domain {
    pub name: String,
    pub version: String,
    pub chain_id: u64,
    /// 0x-hex, 20 bytes.
    pub verifying_contract: String,
}

/// The authorization itself, exactly as it travels in the x402 payload.
#[derive(Debug, Clone, Deserialize)]
pub struct TransferAuthorization {
    /// 0x-hex, 20 bytes. Must be the signing address.
    pub from: String,
    /// 0x-hex, 20 bytes.
    pub to: String,
    /// Decimal atomic units.
    pub value: String,
    /// Decimal unix seconds.
    pub valid_after: String,
    /// Decimal unix seconds.
    pub valid_before: String,
    /// 0x-hex, exactly 32 bytes. Single-use; the token contract rejects a repeat.
    pub nonce: String,
}

fn strip0x(s: &str) -> &str {
    let t = s.trim();
    t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t)
}

/// A 20-byte address, left-padded to an ABI word.
fn word_address(s: &str, field: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(strip0x(s)).map_err(|e| format!("{field}: invalid hex ({e})"))?;
    if bytes.len() != 20 {
        return Err(format!("{field}: expected 20 bytes, got {}", bytes.len()));
    }
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&bytes);
    Ok(word)
}

/// A decimal integer as a big-endian ABI word.
///
/// Parsed as `u128`, not `u256`. Every quantity this message carries — an atomic token
/// amount and two unix timestamps — fits with room to spare, and a value that does not
/// fit is refused rather than truncated into a signature that authorizes something other
/// than what was read.
fn word_uint(s: &str, field: &str) -> Result<[u8; 32], String> {
    let value: u128 = s
        .trim()
        .parse()
        .map_err(|_| format!("{field}: expected a decimal integer, got {s:?}"))?;
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    Ok(word)
}

/// A raw 32-byte value.
fn word_bytes32(s: &str, field: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(strip0x(s)).map_err(|e| format!("{field}: invalid hex ({e})"))?;
    if bytes.len() != 32 {
        return Err(format!("{field}: expected 32 bytes, got {}", bytes.len()));
    }
    let mut word = [0u8; 32];
    word.copy_from_slice(&bytes);
    Ok(word)
}

/// `keccak256(abi.encode(DOMAIN_TYPEHASH, keccak(name), keccak(version), chainId, verifyingContract))`
pub fn domain_separator(domain: &Eip712Domain) -> Result<[u8; 32], String> {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&DOMAIN_TYPEHASH);
    buf.extend_from_slice(&keccak256(domain.name.as_bytes()));
    buf.extend_from_slice(&keccak256(domain.version.as_bytes()));
    buf.extend_from_slice(&word_uint(&domain.chain_id.to_string(), "chainId")?);
    buf.extend_from_slice(&word_address(&domain.verifying_contract, "verifyingContract")?);
    Ok(keccak256(&buf))
}

/// `keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce))`
pub fn struct_hash(auth: &TransferAuthorization) -> Result<[u8; 32], String> {
    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(&TRANSFER_TYPEHASH);
    buf.extend_from_slice(&word_address(&auth.from, "from")?);
    buf.extend_from_slice(&word_address(&auth.to, "to")?);
    buf.extend_from_slice(&word_uint(&auth.value, "value")?);
    buf.extend_from_slice(&word_uint(&auth.valid_after, "validAfter")?);
    buf.extend_from_slice(&word_uint(&auth.valid_before, "validBefore")?);
    buf.extend_from_slice(&word_bytes32(&auth.nonce, "nonce")?);
    Ok(keccak256(&buf))
}

/// `keccak256(0x19 || 0x01 || domainSeparator || structHash)` — what is actually signed.
pub fn transfer_digest(
    domain: &Eip712Domain,
    auth: &TransferAuthorization,
) -> Result<[u8; 32], String> {
    let mut buf = Vec::with_capacity(2 + 64);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(&domain_separator(domain)?);
    buf.extend_from_slice(&struct_hash(auth)?);
    Ok(keccak256(&buf))
}

/// Sign a digest, returning the 65 bytes `r || s || v` an EIP-3009 contract expects.
///
/// `v` is `27 + recovery id`, and `s` is normalized low by k256 — a high-`s` signature is
/// the malleable twin of a valid one, and the token contracts reject it.
pub fn sign_transfer(
    secret: &[u8; 32],
    domain: &Eip712Domain,
    auth: &TransferAuthorization,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let digest = transfer_digest(domain, auth)?;
    let key = signing_key(secret)?;
    let (sig, recid): (Signature, RecoveryId) = key
        .sign_prehash(&digest)
        .map_err(|e| format!("signing failed: {e}"))?;

    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(&sig.to_bytes());
    out.push(27 + recid.to_byte());
    Ok((out, digest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_evm::sign::address_from_secret;

    fn domain() -> Eip712Domain {
        Eip712Domain {
            name: "USDC".into(),
            version: "2".into(),
            chain_id: 8453,
            verifying_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".into(),
        }
    }

    fn auth() -> TransferAuthorization {
        TransferAuthorization {
            from: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A".into(),
            to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C".into(),
            value: "250000".into(),
            valid_after: "1740672089".into(),
            valid_before: "1740672154".into(),
            nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480".into(),
        }
    }

    /// The typehashes are constants here; if either is wrong every signature is worthless
    /// and nothing else in this file would notice.
    #[test]
    fn typehashes_match_their_definitions() {
        assert_eq!(
            keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            DOMAIN_TYPEHASH
        );
        assert_eq!(
            keccak256(b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            TRANSFER_TYPEHASH
        );
    }

    /// Ground truth from `eth_account.sign_message(encode_typed_data(...))` over the same
    /// key and message — an independent implementation, not our own arithmetic replayed.
    #[test]
    fn digest_and_signature_match_eth_account() {
        let secret = [0x11u8; 32];
        assert_eq!(
            address_from_secret(&secret).unwrap(),
            "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"
        );

        let (sig, digest) = sign_transfer(&secret, &domain(), &auth()).unwrap();
        assert_eq!(
            hex::encode(digest),
            "b4dbcd946ee448928225608b9c5334136b56cd3eab56655fb86441a5fe40f03c"
        );
        assert_eq!(
            hex::encode(&sig),
            "93e2ba78b8017e1ffb834e12db36e13ca65b560831e5e9136fb1c0314f67895318f24d5378b6c0b749c8a86320888efcf5fdd04d52d1c04f84848c08b53ee3371b"
        );
        assert_eq!(sig.len(), 65);
        assert!(sig[64] == 27 || sig[64] == 28, "v must be 27 or 28");
    }

    /// Changing the recipient must change the signature. It sounds obvious; it is the
    /// entire security property the facilitator relies on.
    #[test]
    fn the_recipient_is_bound_into_the_signature() {
        let secret = [0x11u8; 32];
        let (a, _) = sign_transfer(&secret, &domain(), &auth()).unwrap();
        let mut elsewhere = auth();
        elsewhere.to = "0x0000000000000000000000000000000000000001".into();
        let (b, _) = sign_transfer(&secret, &domain(), &elsewhere).unwrap();
        assert_ne!(a, b);
    }

    /// And so must the amount, and the chain, and the token.
    #[test]
    fn the_amount_the_chain_and_the_token_are_all_bound() {
        let secret = [0x11u8; 32];
        let (base, _) = sign_transfer(&secret, &domain(), &auth()).unwrap();

        let mut more = auth();
        more.value = "250001".into();
        assert_ne!(sign_transfer(&secret, &domain(), &more).unwrap().0, base);

        let mut other_chain = domain();
        other_chain.chain_id = 1;
        assert_ne!(sign_transfer(&secret, &other_chain, &auth()).unwrap().0, base);

        let mut other_token = domain();
        other_token.verifying_contract = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".into();
        assert_ne!(sign_transfer(&secret, &other_token, &auth()).unwrap().0, base);
    }

    #[test]
    fn rejects_a_malformed_address() {
        let mut bad = auth();
        bad.to = "0xdeadbeef".into();
        assert!(struct_hash(&bad).is_err());
    }

    #[test]
    fn rejects_a_nonce_that_is_not_32_bytes() {
        let mut bad = auth();
        bad.nonce = "0x00".into();
        assert!(struct_hash(&bad).is_err());
    }

    /// A value too large to represent is refused, never truncated: a truncated amount is
    /// a signature authorizing a transfer nobody read.
    #[test]
    fn refuses_an_amount_it_cannot_represent() {
        let mut bad = auth();
        bad.value = "340282366920938463463374607431768211456".into(); // 2^128
        assert!(struct_hash(&bad).is_err());
    }

    #[test]
    fn signing_is_deterministic() {
        let secret = [0x11u8; 32];
        assert_eq!(
            sign_transfer(&secret, &domain(), &auth()).unwrap().0,
            sign_transfer(&secret, &domain(), &auth()).unwrap().0
        );
    }
}
