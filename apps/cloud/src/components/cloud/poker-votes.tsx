import { Check, LockKeyhole, Users } from "lucide-react";
import type { PokerRound } from "@/lib/cloud-contract";
import { PersonAvatar } from "./person-avatar";

export function PokerVotes({ round }: { round: PokerRound }) {
  const revealed = round.status === "revealed" || round.status === "decided";
  const distribution = round.scale
    .map((card) => ({
      ...card,
      count: round.votes.filter((vote) => vote.card === card.label).length,
    }))
    .filter((card) => card.count > 0);
  return (
    <>
      {revealed && distribution.length > 0 && (
        <section
          className="cloud-poker-distribution"
          aria-label="Vote distribution"
        >
          <h3>Results</h3>
          <ul>
            {distribution.map((card) => (
              <li key={card.label}>
                <strong>{card.label}</strong>
                <span className="cloud-poker-result-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${(card.count / round.votes.length) * 100}%`,
                    }}
                  />
                </span>
                <span>
                  {card.count} {card.count === 1 ? "vote" : "votes"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="cloud-poker-participants" aria-label="Participants">
        <header>
          <h3>
            <Users size={15} aria-hidden="true" />
            Participants
          </h3>
          <span className="cloud-count">{round.votes.length}</span>
        </header>
        {!round.votes.length ? (
          <p className="cloud-poker-waiting">No votes yet.</p>
        ) : (
          <ul className="cloud-poker-votes" aria-label="Votes">
            {round.votes.map((vote) => (
              <li key={vote.userId}>
                <PersonAvatar name={vote.name} />
                <span>{vote.name}</span>
                <strong
                  data-hidden={vote.card === null}
                  data-text-card={vote.card !== null && vote.card.length > 3}
                >
                  {vote.card === null ? (
                    <>
                      <LockKeyhole size={14} aria-hidden="true" />
                      <span className="sr-only">Vote hidden</span>
                    </>
                  ) : (
                    vote.card
                  )}
                </strong>
                <Check
                  size={13}
                  className="cloud-poker-voted"
                  aria-label="Voted"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
