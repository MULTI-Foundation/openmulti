# De l'idee a la production

Chaque fonctionnalite suit le meme chemin, entierement dans GitHub. L'etat se
lit sur l'etiquette de l'issue.

| Etape | Ou | Etiquette | Qui fait avancer |
|---|---|---|---|
| 1. Idee | une issue, formulaire « Idee de fonctionnalite » | `idee` | n'importe qui |
| 2. Expression | les commentaires de l'issue | `expression` | les personnes concernees et leurs agents |
| 3. Spec | `specs/<numero>-<titre>.md`, dans une PR qui ne contient que ce fichier | `spec` | l'auteur de la spec ; le mainteneur valide en fusionnant |
| 4. Code | une PR qui cite l'issue et la spec | `pret-a-coder` | l'auteur du code, avec son agent |
| 5. Recette | la PR est fusionnee, la recette est deployee | `en-recette` | le mainteneur |
| 6. Production | deploiement declenche a la main | `en-prod`, puis l'issue est fermee | le mainteneur |

## Regles

- **L'issue porte la discussion, le fichier porte la decision.** Une spec en
  commentaire ne se relit pas ligne a ligne et ne se versionne pas : des que le
  besoin est clair, il s'ecrit dans `specs/` a partir de `_gabarit.md`.
- **Une spec se valide par la fusion de sa PR.** Tant qu'elle n'est pas dans
  `main`, personne ne code dessus.
- **Le code suit la spec.** Si le code doit s'en ecarter, la spec est modifiee
  dans la meme PR, et la description le dit.
- **Les criteres d'acceptation sont verifies deux fois** : par les tests dans
  la PR, puis a la main en recette avant la production.
- Un correctif de bug ou un changement sans effet visible n'a pas besoin de
  spec : une issue et une PR suffisent.

## Nommer le fichier

`specs/<numero de l'issue>-<titre-court>.md`, par exemple
`specs/42-export-des-contacts.md`.
