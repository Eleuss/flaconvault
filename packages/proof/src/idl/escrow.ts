/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/escrow.json`.
 */
export type Escrow = {
  "address": "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL",
  "metadata": {
    "name": "escrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "FlaconVault — USDC escrow with scan-verified handover (briefing §11)"
  },
  "instructions": [
    {
      "name": "cancel",
      "docs": [
        "Seller cancels a LISTED order (asset returned if deposited)."
      ],
      "discriminator": [
        232,
        219,
        223,
        41,
        219,
        236,
        220,
        190
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "asset",
          "writable": true,
          "optional": true
        },
        {
          "name": "mplCoreProgram",
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeOrder",
      "docs": [
        "Seller reclaims a terminal order account (allows re-listing the same passport)."
      ],
      "discriminator": [
        90,
        103,
        209,
        28,
        7,
        63,
        168,
        4
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "depositAsset",
      "docs": [
        "Seller moves the Core asset into escrow custody (optional; LISTED only)."
      ],
      "discriminator": [
        107,
        93,
        89,
        87,
        226,
        203,
        154,
        19
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "asset",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "dispute",
      "docs": [
        "Refund path (admin / buyer on mismatch, timeout or dead seal)."
      ],
      "discriminator": [
        216,
        92,
        128,
        146,
        202,
        85,
        135,
        73
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "buyerToken",
          "docs": [
            "Buyer's USDC token account (refund destination)."
          ],
          "writable": true
        },
        {
          "name": "buyer",
          "writable": true
        },
        {
          "name": "seller"
        },
        {
          "name": "signer",
          "docs": [
            "Admin or buyer (see rules above); pays the Core CPI fee if the asset is returned."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "seal",
          "docs": [
            "flacon `Seal` of the order's passport — pass it to dispute on a dead seal."
          ],
          "optional": true
        },
        {
          "name": "asset",
          "writable": true,
          "optional": true
        },
        {
          "name": "mplCoreProgram",
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initConfig",
      "docs": [
        "Singleton config; payer becomes admin. `usdc_mint` is passed as an account."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "docs": [
            "Payer becomes the escrow admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "usdcMint",
          "docs": [
            "The USDC mint (devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; localnet: a test mint)."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "disputeAfterS",
          "type": "i64"
        }
      ]
    },
    {
      "name": "list",
      "docs": [
        "Seller lists a (non-void) flacon passport for `price` USDC base units."
      ],
      "discriminator": [
        54,
        174,
        193,
        67,
        17,
        41,
        132,
        38
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "passport",
          "docs": [
            "flacon `Passport` (owner = flacon program, discriminator checked)."
          ]
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "passport"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "recordPreShipScan",
      "docs": [
        "Seller links their flacon pre-ship ScanProof."
      ],
      "discriminator": [
        112,
        252,
        169,
        209,
        191,
        114,
        140,
        158
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "seller",
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "scanProof",
          "docs": [
            "flacon `ScanProof` of the seller's pre-ship scan."
          ]
        },
        {
          "name": "seal",
          "docs": [
            "flacon `Seal` the scan was made on."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "recordReceiptScan",
      "docs": [
        "Buyer links their receipt ScanProof; compared with the pre-ship scan → RECEIPT_SCANNED or MISMATCH."
      ],
      "discriminator": [
        192,
        183,
        232,
        178,
        90,
        45,
        91,
        74
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "buyer",
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "scanProof",
          "docs": [
            "flacon `ScanProof` of the buyer's receipt scan."
          ]
        },
        {
          "name": "seal",
          "docs": [
            "flacon `Seal` the receipt scan was made on."
          ]
        },
        {
          "name": "sellerScan",
          "docs": [
            "The seller's pre-ship `ScanProof` recorded on the order."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "release",
      "docs": [
        "Permissionless settlement after a matching receipt scan."
      ],
      "discriminator": [
        253,
        249,
        15,
        206,
        28,
        127,
        193,
        241
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "sellerToken",
          "docs": [
            "Seller's USDC token account (destination)."
          ],
          "writable": true
        },
        {
          "name": "buyer",
          "writable": true
        },
        {
          "name": "caller",
          "docs": [
            "Anyone; pays the Core CPI fee if the asset is transferred."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "asset",
          "writable": true,
          "optional": true
        },
        {
          "name": "mplCoreProgram",
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "reserve",
      "docs": [
        "Buyer funds the vault with `price` USDC."
      ],
      "discriminator": [
        92,
        99,
        244,
        209,
        28,
        65,
        213,
        157
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "buyerToken",
          "docs": [
            "Buyer's USDC token account (source of `price`)."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vault",
          "docs": [
            "USDC vault owned by the Order PDA; rent paid by the buyer, returned on release/dispute.",
            "`init_if_needed` so that a second `reserve` on a funded order reaches the state check",
            "(`InvalidState`) instead of failing with a raw \"account already in use\"; the vault only",
            "exists while the order is funded, and those states are all rejected below."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "setDisputeWindow",
      "docs": [
        "Admin only: default dispute window for future orders."
      ],
      "discriminator": [
        125,
        232,
        78,
        47,
        233,
        47,
        47,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "disputeAfterS",
          "type": "i64"
        }
      ]
    },
    {
      "name": "ship",
      "docs": [
        "Seller marks the parcel as shipped (starts the dispute window)."
      ],
      "discriminator": [
        174,
        78,
        207,
        150,
        205,
        74,
        165,
        217
      ],
      "accounts": [
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.passport",
                "account": "order"
              },
              {
                "kind": "account",
                "path": "order.seller",
                "account": "order"
              }
            ]
          }
        },
        {
          "name": "seller",
          "signer": true,
          "relations": [
            "order"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "escrowConfig",
      "discriminator": [
        138,
        174,
        227,
        187,
        239,
        148,
        1,
        44
      ]
    },
    {
      "name": "order",
      "discriminator": [
        134,
        173,
        223,
        185,
        77,
        86,
        28,
        51
      ]
    }
  ],
  "events": [
    {
      "name": "assetDeposited",
      "discriminator": [
        97,
        219,
        56,
        126,
        243,
        136,
        59,
        195
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "disputeWindowUpdated",
      "discriminator": [
        217,
        172,
        82,
        208,
        102,
        92,
        69,
        196
      ]
    },
    {
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderClosed",
      "discriminator": [
        237,
        77,
        101,
        123,
        72,
        43,
        149,
        123
      ]
    },
    {
      "name": "orderDisputed",
      "discriminator": [
        186,
        104,
        120,
        36,
        95,
        130,
        173,
        128
      ]
    },
    {
      "name": "orderListed",
      "discriminator": [
        235,
        55,
        154,
        70,
        133,
        71,
        114,
        30
      ]
    },
    {
      "name": "orderReleased",
      "discriminator": [
        171,
        232,
        93,
        217,
        184,
        222,
        234,
        29
      ]
    },
    {
      "name": "orderReserved",
      "discriminator": [
        31,
        26,
        190,
        19,
        176,
        19,
        69,
        154
      ]
    },
    {
      "name": "orderShipped",
      "discriminator": [
        200,
        225,
        83,
        123,
        179,
        86,
        221,
        24
      ]
    },
    {
      "name": "preShipScanRecorded",
      "discriminator": [
        228,
        148,
        141,
        200,
        112,
        5,
        58,
        250
      ]
    },
    {
      "name": "receiptScanRecorded",
      "discriminator": [
        192,
        0,
        126,
        169,
        221,
        228,
        135,
        157
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidState",
      "msg": "Order is not in the required state for this instruction"
    },
    {
      "code": 6001,
      "name": "invalidPrice",
      "msg": "price must be > 0"
    },
    {
      "code": 6002,
      "name": "invalidDisputeWindow",
      "msg": "dispute_after_s must be > 0"
    },
    {
      "code": 6003,
      "name": "passportVoid",
      "msg": "Passport is void"
    },
    {
      "code": 6004,
      "name": "notSeller",
      "msg": "Signer is not the order's seller"
    },
    {
      "code": 6005,
      "name": "notBuyer",
      "msg": "Signer is not the order's buyer"
    },
    {
      "code": 6006,
      "name": "sellerCannotBuy",
      "msg": "Seller cannot buy their own listing"
    },
    {
      "code": 6007,
      "name": "unauthorized",
      "msg": "Signer is neither the escrow admin nor an entitled party"
    },
    {
      "code": 6008,
      "name": "wrongMint",
      "msg": "Token account mint does not match the escrow USDC mint"
    },
    {
      "code": 6009,
      "name": "scanSealMismatch",
      "msg": "ScanProof does not belong to the given seal"
    },
    {
      "code": 6010,
      "name": "sealPassportMismatch",
      "msg": "Seal does not belong to the order's passport"
    },
    {
      "code": 6011,
      "name": "scanAttesterMismatch",
      "msg": "ScanProof attester is not the expected party"
    },
    {
      "code": 6012,
      "name": "sellerScanMismatch",
      "msg": "Given seller ScanProof is not the one recorded on the order"
    },
    {
      "code": 6013,
      "name": "receiptScanNotNewer",
      "msg": "Receipt scan on the same seal must have a higher counter than the pre-ship scan"
    },
    {
      "code": 6014,
      "name": "disputeWindowNotElapsed",
      "msg": "Dispute window after shipping has not elapsed yet"
    },
    {
      "code": 6015,
      "name": "sealNotDead",
      "msg": "Seal is not dead"
    },
    {
      "code": 6016,
      "name": "assetMismatch",
      "msg": "Asset account does not match the order's asset"
    },
    {
      "code": 6017,
      "name": "assetAlreadyDeposited",
      "msg": "Asset already deposited"
    },
    {
      "code": 6018,
      "name": "missingAssetAccounts",
      "msg": "Asset custody requires the asset and mpl-core program accounts"
    },
    {
      "code": 6019,
      "name": "invalidCoreProgram",
      "msg": "Not the Metaplex Core program"
    },
    {
      "code": 6020,
      "name": "invalidAsset",
      "msg": "Asset account is not owned by Metaplex Core"
    },
    {
      "code": 6021,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "assetDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "disputeAfterS",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "disputeWindowUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "disputeAfterS",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "escrowConfig",
      "docs": [
        "Seeds `[\"config\"]` — singleton.",
        "",
        "Layout (after the 8-byte discriminator): admin @8 (32) · usdc_mint @40 (32)",
        "· dispute_after_s @72 (i64) · bump @80 (u8) → 81 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "disputeAfterS",
            "docs": [
              "Default window after `ship()` in which the buyer must record a receipt scan."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "order",
      "docs": [
        "Seeds `[\"order\", passport, seller]`.",
        "",
        "Layout (after the 8-byte discriminator):",
        "passport @8 (32) · seller @40 (32) · buyer @72 (32, zero until reserved) · asset @104 (32)",
        "· price @136 (u64) · state @144 (u8) · listed_at @145 (i64) · reserved_at @153 (i64)",
        "· shipped_at @161 (i64) · seller_scan @169 (32) · buyer_scan @201 (32)",
        "· dispute_after_s @233 (i64) · asset_deposited @241 (bool) · bump @242 (u8) · vault_bump @243 (u8)",
        "→ 244 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "docs": [
              "flacon `Passport` PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "docs": [
              "`Pubkey::default()` until `reserve`."
            ],
            "type": "pubkey"
          },
          {
            "name": "asset",
            "docs": [
              "Metaplex Core asset (copied from `passport.asset` at `list`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "price",
            "docs": [
              "USDC base units (6 dp)."
            ],
            "type": "u64"
          },
          {
            "name": "state",
            "docs": [
              "`ORDER_STATE_*`"
            ],
            "type": "u8"
          },
          {
            "name": "listedAt",
            "type": "i64"
          },
          {
            "name": "reservedAt",
            "type": "i64"
          },
          {
            "name": "shippedAt",
            "type": "i64"
          },
          {
            "name": "sellerScan",
            "docs": [
              "flacon `ScanProof` PDA of the seller's pre-ship scan (default until recorded)."
            ],
            "type": "pubkey"
          },
          {
            "name": "buyerScan",
            "docs": [
              "flacon `ScanProof` PDA of the buyer's receipt scan (default until recorded)."
            ],
            "type": "pubkey"
          },
          {
            "name": "disputeAfterS",
            "docs": [
              "Copied from `EscrowConfig.dispute_after_s` at `list` (fixed for this order)."
            ],
            "type": "i64"
          },
          {
            "name": "assetDeposited",
            "docs": [
              "True once the Core asset sits in the Order PDA's custody (`deposit_asset`)."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "docs": [
              "Bump of the `[\"vault\", order]` token account (set at `reserve`)."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "finalState",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "orderDisputed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "docs": [
              "`DISPUTE_REASON_*`"
            ],
            "type": "u8"
          },
          {
            "name": "previousState",
            "type": "u8"
          },
          {
            "name": "refunded",
            "type": "u64"
          },
          {
            "name": "assetReturned",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderListed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "disputeAfterS",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "assetTransferred",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderReserved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderShipped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "passport",
      "docs": [
        "Seeds: `[\"passport\", serial_hash]` — the bottle's birth certificate."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "serialHash",
            "docs": [
              "sha256(serial, UTF-8)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bindingHash",
            "docs": [
              "sha256(serial ‖ batch_code ‖ uid_hash_first_seal)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "asset",
            "docs": [
              "Metaplex Core asset (stored only, no CPI in this program)."
            ],
            "type": "pubkey"
          },
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "grade",
            "docs": [
              "grade enum (constants::GRADE_*)"
            ],
            "type": "u8"
          },
          {
            "name": "scanCount",
            "type": "u32"
          },
          {
            "name": "sealCount",
            "type": "u8"
          },
          {
            "name": "void",
            "type": "bool"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "preShipScanRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "scanProof",
            "type": "pubkey"
          },
          {
            "name": "counter",
            "type": "u32"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "receiptScanRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "scanProof",
            "type": "pubkey"
          },
          {
            "name": "counter",
            "type": "u32"
          },
          {
            "name": "matched",
            "type": "bool"
          },
          {
            "name": "sellerFill",
            "type": "u8"
          },
          {
            "name": "buyerFill",
            "type": "u8"
          },
          {
            "name": "sellerHeat",
            "type": "u8"
          },
          {
            "name": "buyerHeat",
            "type": "u8"
          },
          {
            "name": "sellerHum",
            "type": "u8"
          },
          {
            "name": "buyerHum",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "scanProof",
      "docs": [
        "Seeds: `[\"scan\", seal, counter u32 LE]` — one PDA per accepted scan."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seal",
            "type": "pubkey"
          },
          {
            "name": "counter",
            "type": "u32"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "role",
            "type": "u8"
          },
          {
            "name": "tamper",
            "type": "u8"
          },
          {
            "name": "uv",
            "type": "u8"
          },
          {
            "name": "hum",
            "type": "u8"
          },
          {
            "name": "heat",
            "type": "u8"
          },
          {
            "name": "heatLevels",
            "docs": [
              "6-bit mask, bit i = Thermax field i (29/33/34/37/40/42 °C); bit 4 is decisive."
            ],
            "type": "u8"
          },
          {
            "name": "fill",
            "type": "u8"
          },
          {
            "name": "siteId",
            "docs": [
              "0 = none; otherwise a registry site (only for role VAULT/PARTNER)."
            ],
            "type": "u16"
          },
          {
            "name": "mediaHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bundleHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "attester",
            "type": "pubkey"
          },
          {
            "name": "serverKeyId",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seal",
      "docs": [
        "Seeds: `[\"seal\", uid_hash]` — one NFC seal (box or neck) pointing at a passport."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "docs": [
              "seal_kind enum (constants::SEAL_KIND_*)"
            ],
            "type": "u8"
          },
          {
            "name": "uidHash",
            "docs": [
              "sha256(uid bytes, 7)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lastCounter",
            "type": "u32"
          },
          {
            "name": "dead",
            "type": "bool"
          },
          {
            "name": "attachedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "defaultDisputeAfterS",
      "docs": [
        "Default dispute window after `ship()` without a receipt scan: 7 days."
      ],
      "type": "i64",
      "value": "604800"
    },
    {
      "name": "disputeReasonAdmin",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "disputeReasonMismatch",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "disputeReasonSealDead",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "disputeReasonTimeout",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "fillTolerance",
      "docs": [
        "`release` requires |fill_buyer − fill_seller| ≤ FILL_TOLERANCE (briefing §11)."
      ],
      "type": "u8",
      "value": "5"
    },
    {
      "name": "mplCoreProgramId",
      "docs": [
        "Metaplex Core program (asset custody CPI)."
      ],
      "type": "pubkey",
      "value": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
      "name": "orderSeed",
      "type": "bytes",
      "value": "[111, 114, 100, 101, 114]"
    },
    {
      "name": "orderStateCancelled",
      "type": "u8",
      "value": "8"
    },
    {
      "name": "orderStateDispute",
      "type": "u8",
      "value": "7"
    },
    {
      "name": "orderStateListed",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "orderStateMismatch",
      "type": "u8",
      "value": "6"
    },
    {
      "name": "orderStatePreshipScanned",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "orderStateReceiptScanned",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "orderStateReleased",
      "type": "u8",
      "value": "5"
    },
    {
      "name": "orderStateReserved",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "orderStateShipped",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "vaultSeed",
      "docs": [
        "USDC vault: SPL token account `[\"vault\", order]`, authority = the Order PDA."
      ],
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
