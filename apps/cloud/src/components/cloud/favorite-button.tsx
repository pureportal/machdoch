"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import type { FavoriteKind } from "@/lib/cloud-favorite-contract";
import { cloudRequest } from "./api-client";
import { favoritesChangedEvent } from "./events";
import { useToast } from "./toast";

export function FavoriteButton({
  kind,
  id,
  initial,
}: {
  kind: FavoriteKind;
  id: string;
  initial: boolean;
}) {
  const toast = useToast();
  const [favorite, setFavorite] = useState(initial);
  return (
    <button
      type="button"
      className="cloud-icon-button"
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorite}
      onClick={() => {
        const next = !favorite;
        setFavorite(next);
        void cloudRequest("favorites", {
          method: "POST",
          body: { kind, id, favorite: next },
        })
          .then(() => window.dispatchEvent(new Event(favoritesChangedEvent)))
          .catch((reason: Error) => {
            setFavorite(!next);
            toast(reason.message, "error");
          });
      }}
    >
      <Star size={14} fill={favorite ? "currentColor" : "none"} />
    </button>
  );
}
