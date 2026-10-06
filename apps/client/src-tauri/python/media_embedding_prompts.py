from __future__ import annotations

import re


def expand_embedding_prompt(prompt: str, tokenizer) -> str:
    replacements = {}
    for token in set(tokenizer.tokenize(prompt)):
        if token not in tokenizer.added_tokens_encoder:
            continue
        aliases = [token]
        while f"{token}_{len(aliases)}" in tokenizer.added_tokens_encoder:
            aliases.append(f"{token}_{len(aliases)}")
        if len(aliases) > 1:
            replacements[token] = " ".join(aliases)
    if not replacements:
        return prompt
    pattern = "|".join(re.escape(token) for token in sorted(replacements, key=len, reverse=True))
    return re.sub(r"(?<!\w)(?:" + pattern + r")(?!\w)", lambda match: replacements[match.group()], prompt)
