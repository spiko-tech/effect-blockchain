/**
 * Stellar account (`G…`) and contract (`C…`) addresses, validated as strkeys.
 *
 * Muxed accounts (`M…`) are rejected: they are an off-chain multiplexing convenience on top of a `G…` account and
 * cannot hold balances or be used as contract arguments.
 *
 * @since 0.1.0
 */
import { StrKey } from "@stellar/stellar-sdk"
import { pipe } from "effect/Function"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaTransformation from "effect/SchemaTransformation"

// Declared so arbitraries encode random 32-byte payloads: random base32 strings almost never pass the CRC16 checksum.
const strKey = (expected: string, isValid: (s: string) => boolean, encode: (payload: Buffer) => string) =>
  Schema.declare((u): u is string => Predicate.isString(u) && isValid(u), {
    expected,
    toCodecArbitrary: () =>
      Schema.link<string>()(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)), {
        decode: SchemaGetter.transform((hex: string) => encode(Buffer.from(hex, "hex"))),
        encode: SchemaGetter.forbiddenEncoding
      })
  })

const stellarAccountAddressRegex = /^G[A-Z2-7]{55}$/u

/**
 * A Stellar account address: a `G…` ed25519 public key strkey (56 base32 characters, checksum verified). Input is
 * upper-cased before validation.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarAccountAddress = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String.check(Schema.isUppercased()), SchemaTransformation.toUpperCase()),
  Schema.check(Schema.isPattern(stellarAccountAddressRegex, { expected: "a valid Stellar account address" })),
  Schema.decodeTo(
    strKey("a valid Stellar account checksum", StrKey.isValidEd25519PublicKey, StrKey.encodeEd25519PublicKey),
    SchemaTransformation.passthrough()
  ),
  Schema.brand("StellarAccountAddress"),
  Schema.annotate({
    identifier: "StellarAccountAddress",
    title: "Stellar account address",
    description:
      "a valid Stellar account address, starting with G and followed by 55 base32 characters e.g. \"GBYIQXBKEB655EB3WTRITS6RR5GXEP6SQRBLPREZHNFYKT7WBMTMPR3H\""
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StellarAccountAddress = typeof StellarAccountAddress.Type

const stellarContractAddressRegex = /^C[A-Z2-7]{55}$/u

/**
 * A Stellar (Soroban) contract address: a `C…` contract strkey (56 base32 characters, checksum verified). Input is
 * upper-cased before validation.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarContractAddress = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String.check(Schema.isUppercased()), SchemaTransformation.toUpperCase()),
  Schema.check(Schema.isPattern(stellarContractAddressRegex, { expected: "a valid Stellar contract address" })),
  Schema.decodeTo(
    strKey("a valid Stellar contract checksum", StrKey.isValidContract, StrKey.encodeContract),
    SchemaTransformation.passthrough()
  ),
  Schema.brand("StellarContractAddress"),
  Schema.annotate({
    identifier: "StellarContractAddress",
    title: "Stellar contract address",
    description:
      "a valid Stellar contract address, starting with C and followed by 55 base32 characters e.g. \"CCAANR7HZNOXYZD7SXS2WQLV5BAOXSRZ7V4O43IANSB355QN2RNG7WVC\""
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StellarContractAddress = typeof StellarContractAddress.Type

/**
 * Either a Stellar account address or a Stellar contract address.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarAddress = Schema.Union([StellarAccountAddress, StellarContractAddress])

/**
 * @since 0.1.0
 * @category models
 */
export type StellarAddress = typeof StellarAddress.Type

/**
 * The all-zero ed25519 account, used by Soroban as a placeholder source account (`contract.NULL_ACCOUNT` in
 * `@stellar/stellar-sdk`).
 *
 * @since 0.1.0
 * @category constants
 */
export const NULL_ADDRESS: StellarAccountAddress = StellarAccountAddress.make(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
)
