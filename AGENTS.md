# Regles pour les agents (Codex, Claude Code, autres)

Les regles du depot sont dans [CLAUDE.md](CLAUDE.md) : les lire en entier avant
toute modification. Elles valent pour tout agent, quel que soit l'outil. Ce
fichier ajoute ce qui concerne le travail a plusieurs.

## Avant d'ecrire

- Lire le code concerne et `docs/ARCHITECTURE.md`. Ne jamais affirmer un
  comportement, ni qualifier du code de mort, sans l'avoir verifie dans le code.
- Ne jamais citer un composant comme existant sans donner son chemin.

## Chaque changement passe par une PR

- Une branche par sujet, jamais de push direct sur `main`.
- La PR remplit le modele (`.github/pull_request_template.md`), y compris la
  case sur le code ecrit avec une IA : l'auteur reste responsable de ce que son
  agent a produit.
- Chaque changement de comportement arrive avec le test qui le verrouille.
- Ne pas affaiblir un test pour faire passer la CI (assertion retiree, test
  saute, tolerance elargie) : c'est un defaut en soi, a signaler dans la PR.
- Aucun secret, cle ou jeton dans le depot : il est public.

## Ce qui est verifie sur chaque PR

| Controle | Ou | Bloquant |
|---|---|---|
| Types, tests, test de contrat | `ci.yml` / `test` | oui |
| Secrets, workflows, failles hautes des dependances | `securite.yml` | oui |
| Revue de fond et revue de securite par IA | poste du mainteneur, statut `revue-ia` | oui |

## Ce que la revue regarde en priorite

- Le contrat (`test/contract.test.ts`) : toute modification de ses assertions
  est un changement d'interface pour MyMULTI.
- L'argent : comptage des tokens, prix, plafonds, devis x402. Une erreur
  d'arrondi ou un chemin qui saute le comptage est bloquant.
- L'authentification et les cles : aucune cle amont ou cle client dans une
  reponse, un log ou un message d'erreur.
- Les entrees client (messages, outils, audio, images) : relayees telles
  quelles a l'amont, jamais interpretees comme une instruction a la passerelle.

## Staging et production

- Fusion sur `main` : image construite, signee, et deployee sur la recette.
- Production : uniquement sur un tag `v*`, pose par un mainteneur sur un commit
  deja passe en recette.
