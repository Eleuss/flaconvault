/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/flacon.json`.
 */
export type Flacon = {
  "address": "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL",
  "metadata": {
    "name": "flacon",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "FlaconVault — passport, seal and scan-proof program (briefing §6)"
  },
  "instructions": [
    {
      "name": "addPartner",
      "docs": [
        "Authority only."
      ],
      "discriminator": [
        180,
        111,
        45,
        157,
        241,
        187,
        234,
        88
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "registry"
          ]
        }
      ],
      "args": [
        {
          "name": "partner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "addServerKey",
      "docs": [
        "Authority only. `valid_to == 0` = open-ended."
      ],
      "discriminator": [
        235,
        66,
        203,
        219,
        31,
        171,
        8,
        8
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "registry"
          ]
        }
      ],
      "args": [
        {
          "name": "keyId",
          "type": "u8"
        },
        {
          "name": "pubkey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "validFrom",
          "type": "i64"
        },
        {
          "name": "validTo",
          "type": "i64"
        }
      ]
    },
    {
      "name": "addSite",
      "docs": [
        "Authority only. `label` is UTF-8, zero padded to 32 bytes."
      ],
      "discriminator": [
        170,
        68,
        156,
        76,
        219,
        176,
        127,
        211
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "registry"
          ]
        }
      ],
      "args": [
        {
          "name": "siteId",
          "type": "u16"
        },
        {
          "name": "label",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "attachSeal",
      "docs": [
        "Partner (or authority) only. `kind` ∈ {BOX, NECK}."
      ],
      "discriminator": [
        61,
        26,
        102,
        251,
        202,
        190,
        43,
        208
      ],
      "accounts": [
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "passport",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  115,
                  115,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "passport.serialHash",
                "account": "passport"
              }
            ]
          }
        },
        {
          "name": "seal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "uidHash"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be a registered partner (or the registry authority)."
          ],
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
          "name": "uidHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "kind",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initRegistry",
      "docs": [
        "Creates the singleton registry; the payer becomes `authority`."
      ],
      "discriminator": [
        131,
        22,
        4,
        103,
        24,
        94,
        163,
        239
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "docs": [
            "Payer becomes the registry authority."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "markSealDead",
      "docs": [
        "Partner (or authority) only. Seal no longer answers → seal dead, passport void, grade VOID."
      ],
      "discriminator": [
        65,
        179,
        161,
        140,
        252,
        105,
        7,
        85
      ],
      "accounts": [
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "passport",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  115,
                  115,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "passport.serialHash",
                "account": "passport"
              }
            ]
          }
        },
        {
          "name": "seal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "seal.uidHash",
                "account": "seal"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be a registered partner (or the registry authority) — after a",
            "confirmed no-response (escrow dispute or certification)."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "mintPassport",
      "docs": [
        "Partner (or authority) only. Birth certificate of a bottle."
      ],
      "discriminator": [
        191,
        229,
        65,
        107,
        110,
        33,
        228,
        202
      ],
      "accounts": [
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "passport",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  115,
                  115,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "serialHash"
              }
            ]
          }
        },
        {
          "name": "issuer",
          "docs": [
            "Must be a registered partner (or the registry authority)."
          ],
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
          "name": "serialHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "bindingHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "asset",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "recordScan",
      "docs": [
        "The core: anchors one server-signed scan. Must be preceded in the same",
        "transaction by an `Ed25519Program` instruction over the §4.3 message."
      ],
      "discriminator": [
        84,
        105,
        74,
        98,
        184,
        80,
        165,
        253
      ],
      "accounts": [
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "passport",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  115,
                  115,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "passport.serialHash",
                "account": "passport"
              }
            ]
          }
        },
        {
          "name": "seal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "seal.uidHash",
                "account": "seal"
              }
            ]
          }
        },
        {
          "name": "scanProof",
          "docs": [
            "One PDA per accepted scan: `[\"scan\", seal, counter LE]` (see module docs for `init_if_needed`)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  99,
                  97,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "seal"
              },
              {
                "kind": "arg",
                "path": "args.counter"
              }
            ]
          }
        },
        {
          "name": "attester",
          "docs": [
            "The wallet that attests the scan; pays for the ScanProof."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "recordScanArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "passport",
      "discriminator": [
        18,
        61,
        245,
        239,
        6,
        15,
        18,
        34
      ]
    },
    {
      "name": "registry",
      "discriminator": [
        47,
        174,
        110,
        246,
        184,
        182,
        252,
        218
      ]
    },
    {
      "name": "scanProof",
      "discriminator": [
        208,
        136,
        45,
        119,
        131,
        191,
        85,
        170
      ]
    },
    {
      "name": "seal",
      "discriminator": [
        162,
        149,
        250,
        10,
        100,
        125,
        36,
        168
      ]
    }
  ],
  "events": [
    {
      "name": "partnerAdded",
      "discriminator": [
        118,
        219,
        220,
        117,
        186,
        162,
        106,
        164
      ]
    },
    {
      "name": "passportMinted",
      "discriminator": [
        196,
        50,
        69,
        108,
        203,
        51,
        9,
        146
      ]
    },
    {
      "name": "registryInitialized",
      "discriminator": [
        144,
        138,
        62,
        105,
        58,
        38,
        100,
        177
      ]
    },
    {
      "name": "scanRecorded",
      "discriminator": [
        21,
        215,
        87,
        213,
        12,
        213,
        49,
        171
      ]
    },
    {
      "name": "sealAttached",
      "discriminator": [
        204,
        46,
        119,
        37,
        164,
        144,
        64,
        31
      ]
    },
    {
      "name": "sealMarkedDead",
      "discriminator": [
        42,
        123,
        197,
        68,
        98,
        46,
        127,
        157
      ]
    },
    {
      "name": "serverKeyAdded",
      "discriminator": [
        82,
        41,
        116,
        202,
        180,
        59,
        33,
        89
      ]
    },
    {
      "name": "siteAdded",
      "discriminator": [
        57,
        141,
        195,
        149,
        88,
        67,
        53,
        161
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not the registry authority"
    },
    {
      "code": 6001,
      "name": "notPartner",
      "msg": "Signer is not a registered partner"
    },
    {
      "code": 6002,
      "name": "duplicateServerKey",
      "msg": "A server key with this key_id already exists"
    },
    {
      "code": 6003,
      "name": "serverKeysFull",
      "msg": "Registry holds the maximum number of server keys"
    },
    {
      "code": 6004,
      "name": "invalidKeyValidity",
      "msg": "valid_to must be 0 (open-ended) or >= valid_from"
    },
    {
      "code": 6005,
      "name": "duplicatePartner",
      "msg": "Partner already registered"
    },
    {
      "code": 6006,
      "name": "partnersFull",
      "msg": "Registry holds the maximum number of partners"
    },
    {
      "code": 6007,
      "name": "invalidSiteId",
      "msg": "site_id 0 is reserved for 'no site'"
    },
    {
      "code": 6008,
      "name": "duplicateSite",
      "msg": "A site with this site_id already exists"
    },
    {
      "code": 6009,
      "name": "sitesFull",
      "msg": "Registry holds the maximum number of sites"
    },
    {
      "code": 6010,
      "name": "invalidSealKind",
      "msg": "Seal kind must be 0 (BOX) or 1 (NECK); 2 (LOOP) is reserved"
    },
    {
      "code": 6011,
      "name": "sealCountOverflow",
      "msg": "Passport seal_count overflow"
    },
    {
      "code": 6012,
      "name": "sealPassportMismatch",
      "msg": "Seal does not belong to this passport"
    },
    {
      "code": 6013,
      "name": "sealDead",
      "msg": "Seal is dead (no longer answers) — no further scans"
    },
    {
      "code": 6014,
      "name": "passportVoid",
      "msg": "Passport is void"
    },
    {
      "code": 6015,
      "name": "counterNotIncreasing",
      "msg": "Counter must be greater than the seal's last counter"
    },
    {
      "code": 6016,
      "name": "invalidInstructionsSysvar",
      "msg": "Instructions sysvar account mismatch"
    },
    {
      "code": 6017,
      "name": "missingEd25519Instruction",
      "msg": "The instruction before record_scan must be an Ed25519Program instruction"
    },
    {
      "code": 6018,
      "name": "malformedEd25519Instruction",
      "msg": "Ed25519 instruction data is malformed (expects exactly one signature over a 152-byte message)"
    },
    {
      "code": 6019,
      "name": "unknownServerKey",
      "msg": "No server key with this key_id in the registry"
    },
    {
      "code": 6020,
      "name": "serverKeyMismatch",
      "msg": "Ed25519 public key does not match the registry server key"
    },
    {
      "code": 6021,
      "name": "serverKeyNotValidAtTs",
      "msg": "Server key is not valid at the given ts"
    },
    {
      "code": 6022,
      "name": "messageMismatch",
      "msg": "Signed message does not match the reconstruction from the arguments"
    },
    {
      "code": 6023,
      "name": "invalidRole",
      "msg": "role must be 0..=4"
    },
    {
      "code": 6024,
      "name": "invalidTier",
      "msg": "tier must be 0..=4"
    },
    {
      "code": 6025,
      "name": "tierNotAllowedForRole",
      "msg": "OWNER/SELLER/BUYER may attest at most tier 2 (SELF_MEDIA)"
    },
    {
      "code": 6026,
      "name": "siteIdNotAllowed",
      "msg": "site_id may only be set for role VAULT or PARTNER"
    },
    {
      "code": 6027,
      "name": "unknownSite",
      "msg": "site_id is not registered"
    },
    {
      "code": 6028,
      "name": "invalidIndicator",
      "msg": "tamper/uv/hum/heat codes must be 0..=3"
    },
    {
      "code": 6029,
      "name": "invalidFill",
      "msg": "fill must be 0..=100"
    },
    {
      "code": 6030,
      "name": "invalidHeatLevels",
      "msg": "heat_levels must be a 6-bit mask (< 64)"
    },
    {
      "code": 6031,
      "name": "heatInconsistent",
      "msg": "heat must equal bit 4 of heat_levels when heat is INTACT or TRIGGERED"
    },
    {
      "code": 6032,
      "name": "scanCountOverflow",
      "msg": "Passport scan_count overflow"
    }
  ],
  "types": [
    {
      "name": "partnerAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "partner",
            "type": "pubkey"
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
      "name": "passportMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "serialHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bindingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "recordScanArgs",
      "type": {
        "kind": "struct",
        "fields": [
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
              "6-bit mask, bit i = Thermax field i; bit 4 (40 °C) is the decisive one."
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
              "0 = none; otherwise a registered site (only with role VAULT/PARTNER)."
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
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "serverKeyId",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "registry",
      "docs": [
        "Seeds: `[\"registry\"]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "serverKeys",
            "type": {
              "vec": {
                "defined": {
                  "name": "serverKey"
                }
              }
            }
          },
          {
            "name": "partners",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "sites",
            "type": {
              "vec": {
                "defined": {
                  "name": "site"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "registryInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "registry",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
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
      "name": "scanRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "seal",
            "type": "pubkey"
          },
          {
            "name": "scanProof",
            "type": "pubkey"
          },
          {
            "name": "attester",
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
            "type": "u8"
          },
          {
            "name": "fill",
            "type": "u8"
          },
          {
            "name": "siteId",
            "type": "u16"
          },
          {
            "name": "grade",
            "type": "u8"
          },
          {
            "name": "scanCount",
            "type": "u32"
          },
          {
            "name": "serverKeyId",
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
    },
    {
      "name": "sealAttached",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "seal",
            "type": "pubkey"
          },
          {
            "name": "uidHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "sealCount",
            "type": "u8"
          },
          {
            "name": "attachedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "sealMarkedDead",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passport",
            "type": "pubkey"
          },
          {
            "name": "seal",
            "type": "pubkey"
          },
          {
            "name": "by",
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
      "name": "serverKey",
      "docs": [
        "One accepted server signing key. `valid_to == 0` means open-ended."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keyId",
            "type": "u8"
          },
          {
            "name": "pubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "validFrom",
            "type": "i64"
          },
          {
            "name": "validTo",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "serverKeyAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keyId",
            "type": "u8"
          },
          {
            "name": "pubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "validFrom",
            "type": "i64"
          },
          {
            "name": "validTo",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "site",
      "docs": [
        "A physical location (vault, partner shop). `label` is UTF-8, zero padded."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "siteId",
            "type": "u16"
          },
          {
            "name": "label",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "siteAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "siteId",
            "type": "u16"
          },
          {
            "name": "label",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "eventDispute",
      "type": "u8",
      "value": "8"
    },
    {
      "name": "eventList",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "eventMint",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "eventReceive",
      "type": "u8",
      "value": "6"
    },
    {
      "name": "eventRelease",
      "type": "u8",
      "value": "7"
    },
    {
      "name": "eventReserve",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "eventScan",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "eventSealAttach",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "eventSealDead",
      "type": "u8",
      "value": "9"
    },
    {
      "name": "eventShip",
      "type": "u8",
      "value": "5"
    },
    {
      "name": "gradeA",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "gradeB",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "gradeC",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "gradeD",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "gradeFillAMin",
      "docs": [
        "`fill >= GRADE_FILL_A_MIN` → A"
      ],
      "type": "u8",
      "value": "90"
    },
    {
      "name": "gradeFillBMin",
      "docs": [
        "`fill >= GRADE_FILL_B_MIN` → B"
      ],
      "type": "u8",
      "value": "60"
    },
    {
      "name": "gradeVoid",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "heatDecisiveIndex",
      "docs": [
        "Index of the decisive heat field (vectors.constants.HEAT_DECISIVE_INDEX)."
      ],
      "type": "u8",
      "value": "4"
    },
    {
      "name": "indicatorIntact",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "indicatorMissing",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "indicatorTriggered",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "indicatorUnreadable",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "maxPartners",
      "type": "u8",
      "value": "16"
    },
    {
      "name": "maxServerKeys",
      "type": "u8",
      "value": "8"
    },
    {
      "name": "maxSites",
      "type": "u8",
      "value": "16"
    },
    {
      "name": "msgLen",
      "docs": [
        "Total length of the server-signed message in bytes."
      ],
      "type": "u16",
      "value": "152"
    },
    {
      "name": "msgPrefix",
      "type": "bytes",
      "value": "[70, 86, 83, 67, 65, 78, 49]"
    },
    {
      "name": "originSeed",
      "docs": [
        "Reserved for the `Origin` account (`[\"origin\", passport]`, briefing §6).",
        "Deliberately not implemented in the hackathon build."
      ],
      "type": "bytes",
      "value": "[111, 114, 105, 103, 105, 110]"
    },
    {
      "name": "passportSeed",
      "type": "bytes",
      "value": "[112, 97, 115, 115, 112, 111, 114, 116]"
    },
    {
      "name": "registrySeed",
      "type": "bytes",
      "value": "[114, 101, 103, 105, 115, 116, 114, 121]"
    },
    {
      "name": "roleBuyer",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "roleOwner",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "rolePartner",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "roleSeller",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "roleVault",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "scanSeed",
      "type": "bytes",
      "value": "[115, 99, 97, 110]"
    },
    {
      "name": "sealKindBox",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "sealKindNeck",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "sealSeed",
      "type": "bytes",
      "value": "[115, 101, 97, 108]"
    },
    {
      "name": "tamperClosed",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "tamperOpenedBefore",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "tamperOpenedNow",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "tamperUnknown",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "tierBirth",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "tierCertified",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "tierSelf",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "tierSelfMedia",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "tierSighting",
      "type": "u8",
      "value": "0"
    }
  ]
};
