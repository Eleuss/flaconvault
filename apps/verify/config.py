"""
Configuration module required by the vendored ``libsdm.sdm`` (icedevml/sdm-backend
layout: a top-level ``config`` module). Only SDMMAC_PARAM is read there.
FlaconVault's own settings live in ``fv.config``.
"""

# Name of the query parameter that carries the SDMMAC in the tag URL (briefing §4.2: cmac).
SDMMAC_PARAM = "cmac"
