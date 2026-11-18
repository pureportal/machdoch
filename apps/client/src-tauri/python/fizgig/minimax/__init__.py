"""MiniMax H3: native LoRA/FT training, sampling and joint audio/video inference.

The DiT (``model``) keeps the original checkpoint parameter names, so trained adapters load onto
the released base. ``layout`` owns the packed-sequence geometry and ``sampling`` the denoiser.
"""
