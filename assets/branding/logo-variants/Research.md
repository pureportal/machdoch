# Machdoch logo design research

Reviewed 7 October 2026. These are design directions for selection, not a measured ranking or a trademark clearance.

## Product fit

The repository describes Machdoch as a local-first AI assistant that works with folders, runs commands, completes tasks, and automates repeatable work. This is reflected in `README.md`, `package.json`, and `apps/landing/index.html`. The shared product shell exposes workspaces, task conversations, scheduling, and media workflows. `packages/product-ui/src/application-navigation.tsx` currently uses a terminal symbol in its navigation rail; `assets/branding/logo.png` also uses an open command-window motif.

The design inference is to connect the name to action, commands, workspace files, or connected steps. A robot, brain, or generic AI sparkle would say less about the distinctive interaction. The set explores both compact initials and more descriptive symbols without trying to depict every feature in one mark.

## Sources and decisions

**Henderson & Cote, “Guidelines for Selecting or Modifying Logos,” Journal of Marketing (1998).** The publisher's abstract describes an empirical analysis of 195 logos across 13 design characteristics, with different choices serving different recognition and image objectives. This supports comparing distinct silhouettes rather than asserting that one universal recipe works. Only the publisher abstract was available; the full paper was not reviewed. [Publisher and DOI](https://journals.sagepub.com/doi/10.1177/002224299806200202).

**Luffarelli, Mukesh & Mahmood, “Let the Logo Do the Talking: The Influence of Logo Descriptiveness on Brand Equity,” Journal of Marketing Research (2019).** Six studies associate descriptive logos with easier processing and stronger brand evaluations, with effects moderated by familiarity and product associations. Applying this to Machdoch is an inference: command, folder, and completion cues may communicate its purpose, but the studies do not test these marks or this app. [Accepted author manuscript, University of Westminster](https://westminsterresearch.westminster.ac.uk/download/49743b78fd5f830feb348b96fe6d6cf4817369aefd66025002a7342999530f5a/449749/Manuscript%20JMR.17.0241.R3.pdf).

**Chen, Liu, Feng & Meng, “The visual language of brand logos: Exploring the relationship between logo simplicity and perceptions of brand warmth and competence,” Journal of Business Research (2025).** The publisher's accessible summary reports that simpler logos increased perceived competence and reduced perceived warmth in its studies. Simplicity has tradeoffs; the set therefore includes both crisp and softer forms. Only the accessible publisher summary was reviewed. [Publisher](https://www.sciencedirect.com/science/article/pii/S0148296325004035).

**Adobe, “Logos: Learn What Separates the Great from the Good” (2018).** Its practical guidance emphasizes recognition across environments and sizes. The new assets use a single flat color, transparent backgrounds, and small-size samples; color is not needed to understand the shapes. [Adobe](https://blog.adobe.com/en/publish/2018/02/16/logos-learn-separates-great-good).

**GNOME Human Interface Guidelines, “App Icons.”** The guidance distinguishes app icons from symbolic interface icons and emphasizes assessing detail at smaller sizes. The preview includes 16, 24, and 32 px icon samples and a navigation-rail placement. These SVG concepts are not packaged launcher icons; platform-specific exports can follow selection. [GNOME](https://developer.gnome.org/hig/guidelines/app-icons.html).

## Design directions

| Icon               | Connection to Machdoch                                   |
| ------------------ | -------------------------------------------------------- |
| 01 Action M        | Name recognition with a cut suggesting progress          |
| 02 Open Command    | A simpler expression of the existing command-window mark |
| 03 Connected M     | Name and linked workflow steps                           |
| 04 Workspace       | Files and completed work                                 |
| 05 Prompt Check    | A request becoming a completed task                      |
| 06 Repeat          | Reusable flows and scheduling                            |
| 07 Step Route      | Tasks carried through connected steps                    |
| 08 MD Monogram     | A compact abbreviation of the name                       |
| 09 Forward         | Execution and progress                                   |
| 10 Dialogue Action | Conversation leading to action                           |
| 11 Task Stack      | Working through tasks                                    |
| 12 Converge        | Coordinating inputs toward one outcome                   |

The 12 text variants test lowercase, title case, uppercase, geometric and humanist sans serifs, a monospaced option, and one restrained serif. All spell the actual app name. Fonts are outlined after HarfBuzz shaping, with kerning retained. No tagline, numerical ratings, or invented claims accompany the marks.

Action M + Grotesk is the initial review pairing: it combines a compact name-based silhouette with a clear lowercase wordmark. Open Command + Humanist preserves a stronger connection to the current identity. Connected M + Precise foregrounds reusable workflows. These are design judgments, not audience-test results.

## Scope and remaining checks

The accent is derived from the app's sky color direction in `packages/product-ui/src/theme.css`; it is not a newly adopted brand standard. Dark previews use a lighter accent for visibility. All artwork remains understandable in a single color.

The comparison page tests transparent exports, light and dark backgrounds, compact placements, and multiple sizes. The sidebar and header previews are size references, not changes to the running app. Final selection still needs review in the actual app and a trademark/similarity check. No user recognition study, trademark search, launcher packaging, or animation has been performed.
