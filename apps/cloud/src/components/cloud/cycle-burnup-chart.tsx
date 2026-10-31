"use client";

import { useCallback, useRef, useState } from "react";
import type { CloudCycle } from "@/lib/cloud-contract";
import type { CycleBurnupPoint } from "@/lib/cloud-cycle-contract";

const initialWidth = 640;
const height = 200;
const margin = { top: 14, right: 16, bottom: 24, left: 34 };
const plotHeight = height - margin.top - margin.bottom;

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function niceMaximum(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
    (candidate) => value <= candidate * magnitude,
  )!;
  return step * magnitude;
}

export function CycleBurnupChart({
  cycle,
  points,
}: {
  cycle: CloudCycle;
  points: CycleBurnupPoint[];
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((element: SVGSVGElement | null) => {
    observer.current?.disconnect();
    if (!element) return;
    observer.current = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry!.contentRect.width)),
    );
    observer.current.observe(element);
  }, []);
  if (points.length < 2) return null;
  const plotWidth = width - margin.left - margin.right;
  const usesPoints = points.some((point) => point.scope > 0);
  const scopeOf = (point: CycleBurnupPoint) =>
    usesPoints ? point.scope : point.scopeIssues;
  const completedOf = (point: CycleBurnupPoint) =>
    usesPoints ? point.completed : point.completedIssues;
  const unit = usesPoints ? "points" : "issues";
  const maximum = niceMaximum(Math.max(...points.map(scopeOf), 1));
  const span = Math.max(1, daysBetween(cycle.startsOn, cycle.endsOn));
  const x = (date: string) =>
    margin.left + (daysBetween(cycle.startsOn, date) / span) * plotWidth;
  const y = (value: number) =>
    margin.top + plotHeight - (value / maximum) * plotHeight;
  const path = (value: (point: CycleBurnupPoint) => number) =>
    points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${x(point.date).toFixed(1)} ${y(value(point)).toFixed(1)}`,
      )
      .join(" ");
  const active = hovered === null ? null : points[hovered]!;
  const last = points.at(-1)!;
  return (
    <section
      className="cloud-card cloud-burnup"
      aria-label={`Burn-up in ${unit}`}
    >
      <header>
        <h2>Burn-up</h2>
        <ul className="cloud-burnup-legend">
          <li data-series="completed">Completed</li>
          <li data-series="scope">Scope</li>
        </ul>
      </header>
      <div className="cloud-burnup-plot">
        <svg
          ref={measure}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${completedOf(last)} of ${scopeOf(last)} ${unit} completed by ${shortDate(last.date)}`}
          onPointerLeave={() => setHovered(null)}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const position =
              ((event.clientX - bounds.left) / bounds.width) * width;
            let closest = 0;
            points.forEach((point, index) => {
              if (
                Math.abs(x(point.date) - position) <
                Math.abs(x(points[closest]!.date) - position)
              )
                closest = index;
            });
            setHovered(closest);
          }}
        >
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line
                className="cloud-burnup-grid"
                x1={margin.left}
                x2={width - margin.right}
                y1={y(maximum * fraction)}
                y2={y(maximum * fraction)}
              />
              <text
                className="cloud-burnup-tick"
                x={margin.left - 8}
                y={y(maximum * fraction) + 4}
                textAnchor="end"
              >
                {maximum * fraction}
              </text>
            </g>
          ))}
          <text
            className="cloud-burnup-tick"
            x={margin.left}
            y={height - 6}
          >
            {shortDate(cycle.startsOn)}
          </text>
          <text
            className="cloud-burnup-tick"
            x={width - margin.right}
            y={height - 6}
            textAnchor="end"
          >
            {shortDate(cycle.endsOn)}
          </text>
          <path className="cloud-burnup-scope" d={path(scopeOf)} />
          <path className="cloud-burnup-completed" d={path(completedOf)} />
          {active && (
            <g>
              <line
                className="cloud-burnup-crosshair"
                x1={x(active.date)}
                x2={x(active.date)}
                y1={margin.top}
                y2={margin.top + plotHeight}
              />
              <circle
                className="cloud-burnup-marker"
                data-series="scope"
                cx={x(active.date)}
                cy={y(scopeOf(active))}
                r={4}
              />
              <circle
                className="cloud-burnup-marker"
                data-series="completed"
                cx={x(active.date)}
                cy={y(completedOf(active))}
                r={4}
              />
            </g>
          )}
        </svg>
        {active && (
          <div
            className="cloud-burnup-tooltip"
            style={{
              left: `${(x(active.date) / width) * 100}%`,
            }}
            data-flip={x(active.date) > width * 0.7 || undefined}
          >
            <strong>{shortDate(active.date)}</strong>
            <span>
              Completed {completedOf(active)} {unit}
            </span>
            <span>
              Scope {scopeOf(active)} {unit}
            </span>
          </div>
        )}
      </div>
      <details className="cloud-burnup-table">
        <summary>Table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Completed</th>
              <th scope="col">Scope</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <td>{shortDate(point.date)}</td>
                <td>{completedOf(point)}</td>
                <td>{scopeOf(point)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
