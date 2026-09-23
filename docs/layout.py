# -*- coding: utf-8 -*-
"""Gemeinsame Geometrie Karte + Gehaeuse, Rev. C. Karte: Ursprung oben links, y nach unten."""
CARD_W, CARD_H, CARD_R, CARD_T = 66.0, 34.0, 2.0, 0.76

# ---- Gehaeuse: gestufte Tasche ----
OUT_X, OUT_Y, R_OUT = 70.0, 38.0, 3.0
FLOOR      = 0.8
SEAT_X, SEAT_Y, R_SEAT, SEAT_Z = 66.3, 34.3, 2.2, 1.2     # Stufe 1: Kartensitz (0,15 Spiel je Seite)
LSEAT_X, LSEAT_Y, R_LSEAT, LSEAT_Z = 67.2, 35.2, 1.6, 0.8 # Stufe 2: Lippensitz
TRAY_Z     = FLOOR + SEAT_Z + LSEAT_Z                      # 2.8
WALL_SEAT  = (OUT_X - SEAT_X)/2                            # 1.85
WALL_TOP   = (OUT_X - LSEAT_X)/2                           # 1.40
SHOULDER   = (LSEAT_X - SEAT_X)/2                          # 0.45

FRAME_Z, LIP_Z = 1.0, 0.8
LIP_X, LIP_Y, R_LIP = 66.9, 34.9, 1.5
LEADIN_Z, LEADIN_D = 0.3, 0.6                              # Einfuehrstufe unten an der Lippe
OPEN_X, OPEN_Y, R_OPEN = 62.5, 30.5, 2.0
SLOT_W, SLOT_H = 18.0, 0.9                                 # Durchfuehrung, ab Bodenoberkante
ASSY_Z = TRAY_Z + FRAME_Z                                  # 3.8

# Sichtfenster in KARTEN-Koordinaten + Kartenspiel
VIS_X0, VIS_X1 = (CARD_W-OPEN_X)/2, (CARD_W+OPEN_X)/2      # 1.75 .. 64.25
VIS_Y0, VIS_Y1 = (CARD_H-OPEN_Y)/2, (CARD_H+OPEN_Y)/2      # 1.75 .. 32.25
PLAY = (SEAT_X - CARD_W)/2                                 # 0.15 je Seite
SAFE = 2.5
SX0, SX1, SY0, SY1 = SAFE, CARD_W-SAFE, SAFE, CARD_H-SAFE

# ---- Kartenlayout ----
HEAT = (2.5, 5.6, 33.0, 13.0)
UV   = (36.2, 5.6, 13.0, 13.0)
HIC  = (56.5, 12.1, 4.75)
LBL_BASE = 20.3
PATCH, PGAP, PATCH_Y = 2.5, 0.6, 21.0
PGROUP = {"heat": 2.5, "uv": 36.2, "hic": 56.5 - (4*PATCH+3*PGAP)/2}
CODE_Y, CODE = 24.9, 6.5
ARUCO = (3.5, CODE_Y, CODE)
QR    = (10.8, CODE_Y, CODE)
TXT_X = 18.5
TXT = [(26.4, 1.7, True), (28.6, 1.4, False), (30.8, 1.4, False)]

STACK = [("Trägerlabel Rückseite",          0.20),
         ("Doppelseitiges Klebeband",       0.10),
         ("Karte PVC",                      CARD_T),
         ("Dickster Aufbau (Indikator)",    0.40)]
