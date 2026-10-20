/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/market_escrow.json`.
 */
export type MarketEscrow = {
  "address": "CeyUTXX5CbgUNPM1msfnp6UfLdNh8PGLm8DpvdYJsEXW",
  "metadata": {
    "name": "marketEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "FlaconVault Market — non-custodial stablecoin escrow for marketplace orders (blueprint §7.2, §7.3)"
  },
  "instructions": [
    {
      "name": "acceptSettlement",
      "docs": [
        "The other party accepts exactly the open proposal → split, no fees."
      ],
      "discriminator": [
        203,
        247,
        191,
        177,
        25,
        90,
        88,
        75
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "sellerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.seller",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "signer",
          "docs": [
            "The party that did not make the open proposal."
          ],
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "expectedToBuyer",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeOrder",
      "docs": [
        "Anyone: closes a terminal order and its vault after the offer expired; rent → rent payer."
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
          "name": "rentPayer",
          "writable": true
        },
        {
          "name": "buyerToken",
          "docs": [
            "Required only when the vault is not empty."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "collectFees",
      "docs": [
        "Anyone: forwards a fee vault to the fee recipient's associated token account."
      ],
      "discriminator": [
        164,
        152,
        207,
        99,
        30,
        186,
        19,
        182
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
          "name": "mint"
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "feeDestination",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "config.feeRecipient",
                "account": "marketConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "confirm",
      "docs": [
        "Buyer: received (SHIPPED), or withdraws a dispute (DISPUTED) → release."
      ],
      "discriminator": [
        174,
        1,
        15,
        213,
        3,
        190,
        131,
        0
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.seller",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "dispute",
      "docs": [
        "Buyer or arbiter: halts a SHIPPED order inside its review window (moves no money)."
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "The buyer or the arbiter."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "executeRuling",
      "docs": [
        "Anyone, after the timelock: carries out the ruling."
      ],
      "discriminator": [
        70,
        10,
        148,
        126,
        42,
        240,
        56,
        34
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
            "Required for a REFUND ruling."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "sellerToken",
          "docs": [
            "Required for a RELEASE ruling."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.seller",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "initConfig",
      "docs": [
        "Once, by the program's upgrade authority: offer key, arbiter, fee recipient and the two allowed",
        "mints (USDC, EURC; classic SPL Token, 6 decimals). Creates the fee vault of each mint. There is no",
        "instruction that changes any of it."
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
          "name": "authority",
          "docs": [
            "The program's upgrade authority; pays the rent of the config and the fee vaults."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "eurcMint"
        },
        {
          "name": "usdcFeeVault",
          "docs": [
            "Fee vault of `usdc_mint`, owned by the config PDA. (`init_if_needed`: passing the same mint twice",
            "then fails the duplicate-account check instead of a raw \"already in use\".)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "eurcFeeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "eurcMint"
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
        },
        {
          "name": "program",
          "docs": [
            "This program; only its upgrade authority may create the config (no front-running a fresh deploy)."
          ],
          "address": "CeyUTXX5CbgUNPM1msfnp6UfLdNh8PGLm8DpvdYJsEXW"
        },
        {
          "name": "programData"
        }
      ],
      "args": [
        {
          "name": "offerKey",
          "type": "pubkey"
        },
        {
          "name": "arbiter",
          "type": "pubkey"
        },
        {
          "name": "feeRecipient",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "markShipped",
      "docs": [
        "Seller: shipped (until the ship deadline). Starts the review window of the lane."
      ],
      "discriminator": [
        239,
        5,
        66,
        105,
        238,
        17,
        89,
        97
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
    },
    {
      "name": "openAndDeposit",
      "docs": [
        "Buyer: opens the order `[\"morder\", buyer, order_id]` and deposits `amount + buyer_fee`. Must",
        "directly follow an Ed25519 instruction with the offer key's signature over the terms (`offer.rs`)."
      ],
      "discriminator": [
        28,
        98,
        182,
        79,
        253,
        29,
        88,
        27
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "arg",
                "path": "args.orderId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Token account `[\"vault\", order]` holding the deposit, authority = the order PDA."
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
          "name": "mint"
        },
        {
          "name": "buyer",
          "signer": true
        },
        {
          "name": "buyerToken",
          "docs": [
            "Source of the deposit (any token account of the buyer for `mint`)."
          ],
          "writable": true
        },
        {
          "name": "rentPayer",
          "docs": [
            "Pays the rent of `order` and `vault`; may be the buyer."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
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
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "offerArgs"
            }
          }
        }
      ]
    },
    {
      "name": "proposeSettlement",
      "docs": [
        "Buyer or seller: proposes how much of the deposit goes back to the buyer (DISPUTED or RULED)."
      ],
      "discriminator": [
        228,
        149,
        56,
        61,
        137,
        43,
        106,
        25
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "The buyer or the seller."
          ],
          "signer": true
        }
      ],
      "args": [
        {
          "name": "toBuyer",
          "type": "u64"
        }
      ]
    },
    {
      "name": "refundAfterTmax",
      "docs": [
        "Anyone: DISPUTED and no ruling by T_max → full refund."
      ],
      "discriminator": [
        211,
        56,
        203,
        68,
        165,
        167,
        56,
        50
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
            "The buyer's associated token account for the order's mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "refundUnshipped",
      "docs": [
        "Anyone: PAID and the ship deadline passed → full refund."
      ],
      "discriminator": [
        68,
        79,
        132,
        124,
        3,
        87,
        233,
        201
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
            "The buyer's associated token account for the order's mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "releaseAfterWindow",
      "docs": [
        "Anyone: SHIPPED and the review window passed without a dispute → release."
      ],
      "discriminator": [
        195,
        209,
        130,
        124,
        172,
        20,
        5,
        249
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
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
            "The seller's associated token account for the order's mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "order.seller",
                "account": "marketOrder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "order.mint",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "rule",
      "docs": [
        "Arbiter: `RULING_RELEASE` or `RULING_REFUND` before T_max, with the hash of the published",
        "reasons; starts the order's timelock (moves no money)."
      ],
      "discriminator": [
        66,
        78,
        245,
        75,
        110,
        83,
        136,
        172
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
                  109,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order.buyer",
                "account": "marketOrder"
              },
              {
                "kind": "account",
                "path": "order.orderId",
                "account": "marketOrder"
              }
            ]
          }
        },
        {
          "name": "arbiter",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "ruling",
          "type": "u8"
        },
        {
          "name": "reasonHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "marketConfig",
      "discriminator": [
        119,
        255,
        200,
        88,
        252,
        82,
        128,
        24
      ]
    },
    {
      "name": "marketOrder",
      "discriminator": [
        115,
        56,
        232,
        54,
        30,
        175,
        160,
        202
      ]
    }
  ],
  "events": [
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
      "name": "feesCollected",
      "discriminator": [
        233,
        23,
        117,
        225,
        107,
        178,
        254,
        8
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
      "name": "orderOpened",
      "discriminator": [
        2,
        254,
        197,
        24,
        41,
        166,
        225,
        56
      ]
    },
    {
      "name": "orderRefunded",
      "discriminator": [
        120,
        155,
        10,
        169,
        7,
        98,
        202,
        187
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
      "name": "orderSettled",
      "discriminator": [
        32,
        21,
        123,
        33,
        68,
        59,
        136,
        131
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
      "name": "rulingMade",
      "discriminator": [
        108,
        121,
        116,
        140,
        239,
        209,
        197,
        183
      ]
    },
    {
      "name": "settlementProposed",
      "discriminator": [
        139,
        32,
        64,
        205,
        27,
        154,
        100,
        147
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority may create the config"
    },
    {
      "code": 6001,
      "name": "invalidKey",
      "msg": "Key must not be the default pubkey"
    },
    {
      "code": 6002,
      "name": "offerKeyIsArbiter",
      "msg": "The offer key and the arbiter must be different keys"
    },
    {
      "code": 6003,
      "name": "invalidMint",
      "msg": "Mint must be a classic SPL Token mint with 6 decimals"
    },
    {
      "code": 6004,
      "name": "duplicateMint",
      "msg": "USDC and EURC must be two different mints"
    },
    {
      "code": 6005,
      "name": "mintNotAllowed",
      "msg": "Mint is not allowed by the config"
    },
    {
      "code": 6006,
      "name": "invalidInstructionsSysvar",
      "msg": "Not the instructions sysvar"
    },
    {
      "code": 6007,
      "name": "missingOfferSignature",
      "msg": "open_and_deposit must directly follow an Ed25519 instruction with the signed offer"
    },
    {
      "code": 6008,
      "name": "malformedEd25519Instruction",
      "msg": "Malformed Ed25519 instruction (one signature, data in the instruction itself, 201-byte offer)"
    },
    {
      "code": 6009,
      "name": "offerKeyMismatch",
      "msg": "The offer is not signed by the config's offer key"
    },
    {
      "code": 6010,
      "name": "offerMismatch",
      "msg": "The signed offer differs from the order terms, the buyer, the mint or this program"
    },
    {
      "code": 6011,
      "name": "offerExpired",
      "msg": "The signed offer has expired"
    },
    {
      "code": 6012,
      "name": "offerExpiryTooFar",
      "msg": "The offer expiry lies more than MAX_OFFER_TTL_S in the future"
    },
    {
      "code": 6013,
      "name": "invalidAmount",
      "msg": "amount must be > 0 and amount + buyer_fee must fit in u64"
    },
    {
      "code": 6014,
      "name": "feeTooHigh",
      "msg": "buyer_fee and seller_fee may each be at most MAX_FEE_BPS of amount"
    },
    {
      "code": 6015,
      "name": "invalidLane",
      "msg": "Unknown lane"
    },
    {
      "code": 6016,
      "name": "laneNotSupported",
      "msg": "Lane G is not available with crypto payment"
    },
    {
      "code": 6017,
      "name": "invalidShipDeadline",
      "msg": "ship_deadline must lie MIN_SHIP_WINDOW_S ..= MAX_SHIP_WINDOW_S after now"
    },
    {
      "code": 6018,
      "name": "invalidRulingWindow",
      "msg": "ruling_window_s must be within MIN_RULING_WINDOW_S ..= MAX_RULING_WINDOW_S"
    },
    {
      "code": 6019,
      "name": "invalidTimelock",
      "msg": "timelock_s must be within MIN_TIMELOCK_S ..= MAX_TIMELOCK_S"
    },
    {
      "code": 6020,
      "name": "invalidSeller",
      "msg": "Seller must be a wallet other than the buyer and the arbiter"
    },
    {
      "code": 6021,
      "name": "buyerIsArbiter",
      "msg": "The buyer must not be the arbiter"
    },
    {
      "code": 6022,
      "name": "orderAlreadyExists",
      "msg": "An order with this id already exists for this buyer"
    },
    {
      "code": 6023,
      "name": "invalidState",
      "msg": "Order is not in the required state for this instruction"
    },
    {
      "code": 6024,
      "name": "notBuyer",
      "msg": "Signer is not the order's buyer"
    },
    {
      "code": 6025,
      "name": "notSeller",
      "msg": "Signer is not the order's seller"
    },
    {
      "code": 6026,
      "name": "notArbiter",
      "msg": "Signer is not the arbiter"
    },
    {
      "code": 6027,
      "name": "notParty",
      "msg": "Signer is not entitled to this instruction on this order"
    },
    {
      "code": 6028,
      "name": "shipDeadlinePassed",
      "msg": "The ship deadline has passed: the order can only be refunded"
    },
    {
      "code": 6029,
      "name": "shipDeadlineNotPassed",
      "msg": "The ship deadline has not passed yet"
    },
    {
      "code": 6030,
      "name": "reviewWindowOpen",
      "msg": "The review window after shipping is still open"
    },
    {
      "code": 6031,
      "name": "reviewWindowClosed",
      "msg": "The review window after shipping has closed"
    },
    {
      "code": 6032,
      "name": "rulingDeadlinePassed",
      "msg": "T_max has passed without a ruling: the order can only be refunded"
    },
    {
      "code": 6033,
      "name": "rulingDeadlineNotPassed",
      "msg": "T_max has not passed yet"
    },
    {
      "code": 6034,
      "name": "timelockActive",
      "msg": "The ruling's timelock is still running"
    },
    {
      "code": 6035,
      "name": "invalidRuling",
      "msg": "A ruling is RULING_RELEASE or RULING_REFUND"
    },
    {
      "code": 6036,
      "name": "missingReasonHash",
      "msg": "A ruling must publish a non-zero reason hash"
    },
    {
      "code": 6037,
      "name": "noProposal",
      "msg": "No settlement proposal is open"
    },
    {
      "code": 6038,
      "name": "proposalMismatch",
      "msg": "The proposal differs from the amount the signer agreed to"
    },
    {
      "code": 6039,
      "name": "ownProposal",
      "msg": "A party cannot accept its own proposal"
    },
    {
      "code": 6040,
      "name": "settlementTooLarge",
      "msg": "A settlement cannot give the buyer more than the deposit"
    },
    {
      "code": 6041,
      "name": "missingTokenAccount",
      "msg": "The token account for this payout is missing"
    },
    {
      "code": 6042,
      "name": "offerNotExpired",
      "msg": "The order can be closed only after the offer expired"
    },
    {
      "code": 6043,
      "name": "rentPayerMismatch",
      "msg": "Not the account that paid the order's rent"
    },
    {
      "code": 6044,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
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
            "name": "offerKey",
            "type": "pubkey"
          },
          {
            "name": "arbiter",
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
          }
        ]
      }
    },
    {
      "name": "feesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
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
      "name": "marketConfig",
      "docs": [
        "Seeds `[\"config\"]`, singleton, created once by the program's upgrade authority. It has no setter:",
        "nothing in this program can change the offer key, the arbiter, the fee recipient or the mints.",
        "",
        "Layout (after the 8-byte discriminator): offer_key @8 (32) · arbiter @40 (32) · fee_recipient @72 (32)",
        "· mints @104 (2 × 32) · bump @168 (u8) · fee_vault_bumps @169 (2 × u8) → 171 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offerKey",
            "docs": [
              "Ed25519 key of FlaconVault that signs order terms (`open_and_deposit`). It cannot move funds."
            ],
            "type": "pubkey"
          },
          {
            "name": "arbiter",
            "docs": [
              "May open a dispute on a shipped order and rule RELEASE or REFUND on a disputed one."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "docs": [
              "Owner of the token accounts `collect_fees` forwards the fee vaults to."
            ],
            "type": "pubkey"
          },
          {
            "name": "mints",
            "docs": [
              "Allowed mints: `[USDC, EURC]` (classic SPL Token, 6 decimals)."
            ],
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "feeVaultBumps",
            "docs": [
              "Bumps of the fee vaults `[\"fees\", mints[i]]`."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          }
        ]
      }
    },
    {
      "name": "marketOrder",
      "docs": [
        "Seeds `[\"morder\", buyer, order_id]` (`order_id`: 16 random bytes, not the marketplace order number).",
        "",
        "Layout (after the 8-byte discriminator):",
        "order_id @8 (16) · buyer @24 (32) · seller @56 (32) · mint @88 (32) · rent_payer @120 (32)",
        "· amount @152 (u64) · buyer_fee @160 (u64) · seller_fee @168 (u64) · lane @176 (u8) · state @177 (u8)",
        "· resolution @178 (u8) · review_window_s @179 (u32) · ruling_window_s @183 (u32) · timelock_s @187 (u32)",
        "· ship_deadline @191 (i64) · offer_expiry @199 (i64) · opened_at @207 (i64) · shipped_at @215 (i64)",
        "· disputed_at @223 (i64) · disputed_by @231 (u8) · ruled_at @232 (i64) · ruling @240 (u8)",
        "· reason_hash @241 (32) · proposal_by @273 (u8) · proposal_to_buyer @274 (u64) · ended_at @282 (i64)",
        "· bump @290 (u8) · vault_bump @291 (u8) → 292 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "docs": [
              "The seller's own wallet (from the signed offer); proceeds go to its associated token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "USDC or EURC."
            ],
            "type": "pubkey"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Paid the rent of this account and of the vault; gets it back at `close_order`."
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Item price in base units."
            ],
            "type": "u64"
          },
          {
            "name": "buyerFee",
            "docs": [
              "Buyer protection, paid by the buyer on top of `amount`."
            ],
            "type": "u64"
          },
          {
            "name": "sellerFee",
            "docs": [
              "Seller commission, deducted from `amount` on release."
            ],
            "type": "u64"
          },
          {
            "name": "lane",
            "docs": [
              "`LANE_*`"
            ],
            "type": "u8"
          },
          {
            "name": "state",
            "docs": [
              "`STATE_*`"
            ],
            "type": "u8"
          },
          {
            "name": "resolution",
            "docs": [
              "`RESOLUTION_*` (set with the terminal state)."
            ],
            "type": "u8"
          },
          {
            "name": "reviewWindowS",
            "docs": [
              "Review window after `mark_shipped`, fixed by the lane."
            ],
            "type": "u32"
          },
          {
            "name": "rulingWindowS",
            "docs": [
              "T_max after `dispute` (signed)."
            ],
            "type": "u32"
          },
          {
            "name": "timelockS",
            "docs": [
              "Timelock after `rule` (signed)."
            ],
            "type": "u32"
          },
          {
            "name": "shipDeadline",
            "docs": [
              "After this instant `mark_shipped` is closed and the buyer can be refunded (signed)."
            ],
            "type": "i64"
          },
          {
            "name": "offerExpiry",
            "docs": [
              "Expiry of the signed offer; the account can be closed only after it (no replay of the offer)."
            ],
            "type": "i64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "shippedAt",
            "type": "i64"
          },
          {
            "name": "disputedAt",
            "type": "i64"
          },
          {
            "name": "disputedBy",
            "docs": [
              "`PARTY_BUYER` or `PARTY_ARBITER`."
            ],
            "type": "u8"
          },
          {
            "name": "ruledAt",
            "type": "i64"
          },
          {
            "name": "ruling",
            "docs": [
              "`RULING_*`"
            ],
            "type": "u8"
          },
          {
            "name": "reasonHash",
            "docs": [
              "Hash of the published reasons of the ruling."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "proposalBy",
            "docs": [
              "`PARTY_BUYER` / `PARTY_SELLER` of the open settlement proposal, `PARTY_NONE` if there is none."
            ],
            "type": "u8"
          },
          {
            "name": "proposalToBuyer",
            "docs": [
              "Base units the proposal gives the buyer; the rest of the deposit goes to the seller."
            ],
            "type": "u64"
          },
          {
            "name": "endedAt",
            "docs": [
              "When the terminal state was reached."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "offerArgs",
      "docs": [
        "Order terms as signed by the offer key (buyer and mint come from the accounts)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "docs": [
              "16 random bytes chosen by the server; part of the order PDA seeds."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "buyerFee",
            "type": "u64"
          },
          {
            "name": "sellerFee",
            "type": "u64"
          },
          {
            "name": "lane",
            "type": "u8"
          },
          {
            "name": "shipDeadline",
            "type": "i64"
          },
          {
            "name": "rulingWindowS",
            "type": "u32"
          },
          {
            "name": "timelockS",
            "type": "u32"
          },
          {
            "name": "expiry",
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
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "sweptToBuyer",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
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
            "type": "u8"
          },
          {
            "name": "rulingDeadline",
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
      "name": "orderOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "buyerFee",
            "type": "u64"
          },
          {
            "name": "sellerFee",
            "type": "u64"
          },
          {
            "name": "lane",
            "type": "u8"
          },
          {
            "name": "shipDeadline",
            "type": "i64"
          },
          {
            "name": "rentPayer",
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
      "name": "orderRefunded",
      "docs": [
        "The buyer got the whole deposit back."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "resolution",
            "type": "u8"
          },
          {
            "name": "toBuyer",
            "type": "u64"
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
      "docs": [
        "The seller was paid (`to_seller`) and the fees went to the fee vault (`fees`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "resolution",
            "type": "u8"
          },
          {
            "name": "toSeller",
            "type": "u64"
          },
          {
            "name": "fees",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "toBuyer",
            "type": "u64"
          },
          {
            "name": "toSeller",
            "type": "u64"
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
            "name": "reviewUntil",
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
      "name": "rulingMade",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "ruling",
            "type": "u8"
          },
          {
            "name": "reasonHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executableAfter",
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
      "name": "settlementProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "u8"
          },
          {
            "name": "toBuyer",
            "type": "u64"
          },
          {
            "name": "toSeller",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "docs": [
        "Singleton config `[\"config\"]`."
      ],
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "feeVaultSeed",
      "docs": [
        "Fee vault: SPL token account `[\"fees\", mint]`, authority = the config PDA (one per allowed mint)."
      ],
      "type": "bytes",
      "value": "[102, 101, 101, 115]"
    },
    {
      "name": "laneA",
      "docs": [
        "Lane A (photos): review window 14 days after `mark_shipped`."
      ],
      "type": "u8",
      "value": "2"
    },
    {
      "name": "laneG",
      "docs": [
        "Lane G (inspection hub): not available with crypto until the hub steps are on chain (§7.2)."
      ],
      "type": "u8",
      "value": "3"
    },
    {
      "name": "laneS",
      "docs": [
        "Lane S (sealed bottle): review window 10 days after `mark_shipped`."
      ],
      "type": "u8",
      "value": "1"
    },
    {
      "name": "maxFeeBps",
      "docs": [
        "Buyer fee and seller commission are each capped at 20 % of the item amount, so even a misused",
        "offer key cannot sign away the seller's proceeds."
      ],
      "type": "u64",
      "value": "2000"
    },
    {
      "name": "maxOfferTtlS",
      "docs": [
        "A signed offer may be valid for at most one hour (the USDC rate holds 10 minutes, §7.1)."
      ],
      "type": "i64",
      "value": "3600"
    },
    {
      "name": "maxRulingWindowS",
      "type": "u32",
      "value": "5184000"
    },
    {
      "name": "maxShipWindowS",
      "type": "i64",
      "value": "2592000"
    },
    {
      "name": "maxTimelockS",
      "type": "u32",
      "value": "259200"
    },
    {
      "name": "mintDecimals",
      "docs": [
        "Allowed mints: classic SPL Token mints with 6 decimals (USDC, EURC)."
      ],
      "type": "u8",
      "value": "6"
    },
    {
      "name": "minRulingWindowS",
      "docs": [
        "T_max: the arbiter must rule within 7 ..= 60 days (signed per order) after the dispute opened."
      ],
      "type": "u32",
      "value": "604800"
    },
    {
      "name": "minShipWindowS",
      "docs": [
        "The signed ship deadline must lie 1 ..= 30 days after `open_and_deposit`."
      ],
      "type": "i64",
      "value": "86400"
    },
    {
      "name": "minTimelockS",
      "docs": [
        "Timelock between `rule` and `execute_ruling`: 48 ..= 72 h (signed per order)."
      ],
      "type": "u32",
      "value": "172800"
    },
    {
      "name": "offerMsgLen",
      "docs": [
        "Length of the signed offer message (see `offer.rs`)."
      ],
      "type": "u16",
      "value": "201"
    },
    {
      "name": "offerPrefix",
      "docs": [
        "Domain prefix of the signed offer message (8 bytes)."
      ],
      "type": "bytes",
      "value": "[70, 86, 77, 75, 84, 79, 70, 49]"
    },
    {
      "name": "orderSeed",
      "docs": [
        "`MarketOrder` `[\"morder\", buyer, order_id (16 random bytes)]`."
      ],
      "type": "bytes",
      "value": "[109, 111, 114, 100, 101, 114]"
    },
    {
      "name": "partyArbiter",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "partyBuyer",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "partyNone",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "partySeller",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "resolutionConfirmed",
      "docs": [
        "`confirm` by the buyer."
      ],
      "type": "u8",
      "value": "1"
    },
    {
      "name": "resolutionNone",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "resolutionRulingRefund",
      "docs": [
        "`execute_ruling` of a REFUND ruling."
      ],
      "type": "u8",
      "value": "5"
    },
    {
      "name": "resolutionRulingRelease",
      "docs": [
        "`execute_ruling` of a RELEASE ruling."
      ],
      "type": "u8",
      "value": "3"
    },
    {
      "name": "resolutionSettlement",
      "docs": [
        "`accept_settlement`."
      ],
      "type": "u8",
      "value": "7"
    },
    {
      "name": "resolutionTmax",
      "docs": [
        "`refund_after_tmax`: no ruling by T_max."
      ],
      "type": "u8",
      "value": "6"
    },
    {
      "name": "resolutionUnshipped",
      "docs": [
        "`refund_unshipped`."
      ],
      "type": "u8",
      "value": "4"
    },
    {
      "name": "resolutionWindow",
      "docs": [
        "`release_after_window`."
      ],
      "type": "u8",
      "value": "2"
    },
    {
      "name": "reviewWindowSLaneA",
      "docs": [
        "Review window after `mark_shipped`, lane A."
      ],
      "type": "u32",
      "value": "1209600"
    },
    {
      "name": "reviewWindowSLaneS",
      "docs": [
        "Review window after `mark_shipped`, lane S."
      ],
      "type": "u32",
      "value": "864000"
    },
    {
      "name": "rulingNone",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "rulingRefund",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "rulingRelease",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "stateDisputed",
      "docs": [
        "Halted by `dispute`; waits for a ruling, a settlement or `refund_after_tmax`."
      ],
      "type": "u8",
      "value": "3"
    },
    {
      "name": "statePaid",
      "docs": [
        "Funded, waiting for `mark_shipped`."
      ],
      "type": "u8",
      "value": "1"
    },
    {
      "name": "stateRefunded",
      "docs": [
        "Terminal: the buyer got the whole deposit back."
      ],
      "type": "u8",
      "value": "6"
    },
    {
      "name": "stateReleased",
      "docs": [
        "Terminal: the seller was paid, the fees went to the fee vault."
      ],
      "type": "u8",
      "value": "5"
    },
    {
      "name": "stateRuled",
      "docs": [
        "The arbiter ruled; the timelock runs, then `execute_ruling`. A settlement is still possible."
      ],
      "type": "u8",
      "value": "4"
    },
    {
      "name": "stateSettled",
      "docs": [
        "Terminal: buyer and seller split the deposit (no fees)."
      ],
      "type": "u8",
      "value": "7"
    },
    {
      "name": "stateShipped",
      "docs": [
        "Shipped, the buyer's review window runs."
      ],
      "type": "u8",
      "value": "2"
    },
    {
      "name": "vaultSeed",
      "docs": [
        "Order vault: SPL token account `[\"vault\", order]`, authority = the order PDA."
      ],
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
