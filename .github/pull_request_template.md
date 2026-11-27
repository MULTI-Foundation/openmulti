## Ce que ca change, et pourquoi

<!-- Le probleme, le choix retenu. Lier le ticket s'il existe. -->

- Issue : #
- Spec : `specs/` (ou "sans spec" : correctif ou changement sans effet visible)

## Comment c'est verifie

<!-- Commandes lancees, scenarios couverts. -->

- [ ] `npm run typecheck` et `npm test` passent en local
- [ ] Chaque changement de comportement a son test, nomme ici :
- [ ] `test/contract.test.ts` n'est pas modifie (sinon c'est un changement
      d'interface pour MyMULTI : le dire et le coordonner)

## Risques

- [ ] Supprime ou modifie un comportement existant (lequel :            )
- [ ] Touche le routage, la facturation, le comptage ou l'authentification
- [ ] Touche un secret, `deploy/` ou `.github/`

Rappel : une fusion sur `main` deploie la recette ; la production part sur un tag `v*`.

## Code ecrit avec une IA

- [ ] J'ai relu chaque ligne de cette PR et je peux l'expliquer. Ce que je n'ai
      pas relu ligne a ligne, et comment je l'ai valide :
