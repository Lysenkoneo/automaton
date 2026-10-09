# Propriété des tentatives de tâches

Chaque affectation créée par `assignTask` reçoit un ULID. Il est persisté dans
`task_graph.attempt_id` et dans `task_attempts`, dont la clé primaire interdit
de réutiliser un identifiant retiré. Le worker local, son contexte et son résultat
portent cet identifiant. Un worker distant doit renvoyer l'`attemptId` reçu dans
`task_assignment`, au niveau du contenu de `task_result` ou de son objet `result`.
Les résultats sans identifiant ou avec des identifiants contradictoires sont
rejetés et signalés. Les anciens workers restent incompatibles avec les nouvelles
affectations : ils doivent être mis à jour avant de recevoir du travail. Un parent
n'invente jamais un token pour leur réponse, même si l'adresse n'a pas changé.

Le token est conservé dans le message typé, son contenu JSON et le résultat.
`SocialRelayTransport` transmet l'enveloppe inchangée ; les relais parent/enfant
préservent également les messages typés. `LocalDBTransport` peut résoudre une
base destinataire distincte ; sans résolveur, il demeure une file locale et ne
constitue pas un transport vers une autre machine. La boucle utilise le relay
social lorsqu'il est configuré. Les producteurs génériques refusent un message
typé ambigu ou sans token. Un texte libre n'est pas un résultat de tâche accepté.

Le récepteur conserve l'affectation originale sous `colony.assignment.<attemptId>`.
`getReceivedTaskAssignment` permet de la retrouver après redémarrage.
`executeTaskAssignment` et `createTaskResultMessage` lient la réponse à cette
affectation précise, jamais à la dernière affectation de la tâche. Le premier est
une API pour l'exécuteur distant ; la messagerie ne démarre pas automatiquement
un harness distant et ne garantit pas la reprise automatique d'une exécution.
La boucle conversationnelle doit renvoyer ce même token dans ses messages typés.

## Migration V12 et récupération

V12 ajoute des structures dans une transaction incluant la version de schéma.
Un échec DDL annule ces ajouts et ferme la connexion ouverte pour la migration.
Les affectations actives existantes gardent leur `attempt_id` NULL et leurs données.
Elles sont mises en quarantaine logique : aucun tick ne les réaffecte, même si
le registre les déclare mortes. Aucun résultat sans token ne les termine.
Cette règle vaut aussi pour une ancienne affectation au parent. `complete_task`
exige désormais l’adresse propriétaire et le token de l’affectation originale ;
il ne complète ni une affectation historique sans token ni une nouvelle tentative
avec un ancien token. La replanification du goal est bloquée tant qu’une
affectation active sans token subsiste. Les APIs administratives brutes du parent
restent privilégiées : ce contrôle ne protège pas leur utilisation hors contexte.

La reprise de ces tâches nécessite une intervention : arrêter et vérifier l'arrêt
de tous les processus anciens, neutraliser les opérations externes ou attendre
leur terminaison confirmée, puis seulement remettre la tâche en attente via une
transaction du parent. Un timeout, une absence du registre ou un accusé de
réception ne constitue pas cette preuve. Si l'arrêt des effets externes ne peut
pas être établi, la tâche doit rester bloquée. Ce correctif n'automatise pas cette
neutralisation. Les résultats reçus sont appliqués avant la récupération et avant
les nouvelles affectations ; un échec réessayable attend le tick suivant.

## Écritures SQLite

`TaskAttemptScope` donne au harness une connexion révocable. Les opérations
SQLite utilisent par défaut une transaction `IMMEDIATE` pour le contrôle de
propriété et l’écriture du worker. Les modes explicites `.deferred` et `.exclusive`
sont conservés ; les transactions imbriquées utilisent des savepoints. Le parent
hors contexte worker conserve son mode natif `DEFERRED`. Dans une transaction
`DEFERRED` préexistante, le contrôle ne prend pas rétroactivement un verrou
`IMMEDIATE` : la contention SQLite, notamment le conflit de snapshot WAL, doit
faire échouer une écriture concurrente devenue périmée. Les tests vérifient les
modes explicites, la contention entre connexions et le rollback d’un savepoint. Les statements conservés avant une attente sont contrôlés à leur
exécution, y compris les écritures avec `RETURNING` et les itérateurs.

Le contexte d'outils utilise également cette connexion. Les méthodes synchrones
d'`AutomatonDatabase`, du suivi des dépenses et du moteur de politique sont
protégées même lorsqu'elles encapsulent une connexion brute. Les appels directs
à `completeTask`, `failTask` et aux transactions de décomposition héritent de la
tentative via `AsyncLocalStorage`, y compris après un `await`. Les appels du
parent hors contexte worker conservent leur autorité. Les résultats distants
passent explicitement leur tentative aux APIs d'écriture.

Ce mécanisme protège les APIs fournies aux harnesses de confiance ; il ne
constitue pas un sandbox contre du JavaScript hostile, une connexion ouverte
séparément ou un processus shell qui accède directement au fichier SQLite.

## Arrêt et reprise

`shutdown()` arrête et attend uniquement les workers présents dans son snapshot.
Chaque worker retire sa propre entrée dans `finally`. Un worker démarré pendant
cette attente reste enregistré dans tous les pools de la connexion.
Le registre reste lié à l'objet connexion SQLite : deux connexions au même
fichier ne constituent pas un registre de présence partagé entre processus.

## Fichiers et effets externes : limite non résolue

Les artefacts du planner sont placés sous
`<workspace>/<goal>/attempts/<attemptId>/`, pour éviter les collisions entre
tentatives. Les nouveaux appels d'outils, les opérations Conway et les replis
locaux après un échec distant vérifient la propriété. Les opérations synchrones
du workspace sont également contrôlées sous verrou SQLite.

Une opération asynchrone déjà lancée peut néanmoins terminer après une
réaffectation : écriture distante, `fs.writeFile` déjà en cours, commande shell
ou processus enfant détaché. Le contrôle avant l'appel ne garantit pas son
annulation. Les writes/patches du projet ne sont donc PAS entièrement protégés
par ce correctif, et un shell disposant des droits du parent peut aussi contourner
la protection SQLite. Un appel bloqué sans retour peut retenir son contexte ;
le timeout du harness n'interrompt pas à lui seul une opération en cours.

La solution sûre est d'exécuter chaque tentative dans un sandbox/processus isolé,
avec un système de fichiers privé et sans accès en écriture à la base, au dépôt
partagé ou aux credentials du parent. Les mutations SQLite doivent passer par
un service du parent qui vérifie le token. Le worker produit des fichiers ou un
patch privés ; seul le parent publie ces changements après arrêt des processus
de la tentative et contrôle du token, dans une section sérialisée avec la
réaffectation. Aucun shell arbitraire ne doit pouvoir écrire dans l'espace
partagé. Cette isolation complète n'est pas implémentée : les harnesses utilisent
des objets en mémoire, des clients avec credentials et des shells ayant les
permissions du parent. Les déplacer seuls dans un processus ne retire ni ces
droits ni les opérations distantes déjà engagées. Il faut une séparation effective
des permissions et un service du parent pour les effets autorisés.

## Partage des outputs et décisions entre tâches

Le worker reçoit une copie privée des outputs/decisions préexistants du goal et
des publications validées dans `worker.workspace.<goalId>`. Seuls les nouveaux
outputs ou leur contenu modifié et les décisions ajoutées sont publiés. Les
publications concurrentes fusionnent leurs deltas ; pour un même nom d’output,
la dernière mutation publiée, écriture ou suppression, gagne. La disparition
d’un output hérité publie un tombstone dans `deletedOutputs` et retire sa valeur
de `outputs`. Le tombstone masque aussi le fichier physique hérité du goal lors
des lectures suivantes, y compris après redémarrage ; une nouvelle écriture
explicite retire le tombstone. La réécriture des décisions héritées reste interdite.
Les anciens instantanés privés et les fichiers physiques possédés par le parent
ne sont pas effacés : les consommateurs du partage doivent lire la vue publiée,
pas directement l’ancien répertoire. Les tests couvrent suppression d’une sortie
publiée et d’une sortie héritée, puis lecture par une nouvelle tentative et le
planner après réouverture de la base.

La publication SQLite et `completeTask` partagent la transaction verrouillée et
le contrôle du token : révocation ou échec de completion ne publie rien. Les
fichiers privés ne sont pas la source du partage après publication. Un nouveau
worker, même après redémarrage, reconstitue sa copie depuis la base. Le parent
planner lit également un instantané des publications dans un répertoire nouveau
à chaque lecture. Une suppression physique d’un fichier parent non publié ne
laisse pas de fichier obsolète dans le suivant ; les suppressions de publications
sont représentées par les tombstones ci-dessus ; les anciennes vues et les tentatives concurrentes
conservent leurs fichiers propres. Les subplans/checkpoints
restent privés à la tentative ; les chemins arbitraires indiqués dans `artifacts`
et les fichiers du projet ne sont pas importés automatiquement.

Cette publication concerne les APIs synchrones du workspace et des harnesses
de confiance. Elle ne protège pas une base ouverte directement par un shell,
les chemins arbitraires du projet, une ancienne URL distante ni la lecture
ultérieure d'un chemin de fichier privé encore modifiable par un processus.
Les publications, reçus, `task_attempts` et répertoires de vues persistent sans
politique de purge ; leur volume doit être surveillé.

## Réception durable et application idempotente

L’ack de l’inbox et la sauvegarde du résultat accepté dans `kv`, sous une clé
`colony.result.<inboxId>`, partagent une transaction SQLite, aussi bien pour la
messagerie que pour l’ack générique de la boucle agent. L’ack générique d’une
affectation persiste également son reçu original ; l’échec de persistance annule
l’ack. La messagerie n’acquitte un message valide qu’après succès du handler et
des écritures requises. Les messages malformés sont conservés dans
`colony.inbox-quarantine.<inboxId>` et retirés du flux normal, sans succès déclaré.

L’application de la completion (ou de l’échec) et la suppression de son entrée
partagent une seconde transaction, sur la même connexion. Ce sont **deux
transactions**, pas une atomicité globale ack/completion. Un crash entre elles
laisse le résultat durable rejouable après ouverture de la base. Deux
consommateurs ne peuvent pas appliquer deux fois la même entrée. Un résultat
accepté n’expire pas pendant sa reprise. Les résultats périmés ou ambigus sont
rejetés et retirés ; une erreur de retrait passe aussi par le retry par entrée.

Un échec de traitement est enregistré indépendamment pour chaque entrée :
`colony.inbox-retry.<inboxId>` avant l’ack, ou
`colony.result-retry.<queueKey>` après staging. Les retries sont différés de
1 seconde puis 2 secondes ; le troisième échec met l’entrée en quarantaine.
Le payload source reste non acquitté dans l’inbox, ou intact dans la file durable.
Les autres entrées continuent. L’opérateur inspecte le payload et la cause stockée,
corrige le problème puis appelle `releaseInboxMessage` ou `releaseTaskResult` ;
ces méthodes retirent uniquement l’état de retry. Elles ne réaffectent pas la
tâche et ne substituent aucun token. Le contrôle de propriété reste requis au rejeu.

La messagerie lit deux lots distincts de 200 entrées, résultats puis autres
messages, en excluant les backoffs et quarantaines. Une tâche est protégée de la
récupération seulement si un résultat de sa tentative originale attend encore
dans l’inbox ou la file, y compris en quarantaine. Les messages ordinaires et les
résultats d’autres tâches ne suspendent pas la récupération des workers morts.
Le test du 201e résultat couvre aussi un taskId fourni uniquement dans le contenu.
Un autre test maintient un flux ordinaire supérieur à 200 messages sur deux ticks.
Le résultat mis en quarantaine bloque volontairement sa propre tâche jusqu’à
intervention, mais pas le traitement des autres résultats.

Ces retries nécessitent une base lisible et inscriptible. Une panne globale de
stockage, un échec de lecture de la file ou une corruption des métadonnées peut
encore atteindre le catch global de l’orchestrateur ; aucune garantie générale
« toute erreur SQLite laisse le goal actif » n’est revendiquée. La sélection
SQLite de la messagerie respecte les quarantaines ; d’autres consommateurs
utilisant directement le getter générique de l’inbox ne suivent pas ces délais.
Les APIs administratives brutes restent hors de ce protocole.

Les tests reproduisent la fermeture/réouverture après ack des deux chemins,
l’échec transactionnel entre completion et suppression de la file, l’échec du
staging avant ack, le dépassement du TTL après acceptation et deux connexions
consommant le même résultat. La garantie concerne un crash de processus et les
transactions SQLite ; le réglage WAL/NORMAL ne garantit pas la conservation des
derniers commits lors d’une coupure électrique. La livraison distante avant
réception reste tributaire du transport : aucun outbox durable de l’émetteur ni
rejeu automatique de l’exécution distante n’est ajouté ici.

## Coûts des échecs

Les résultats locaux et distants conservent les coûts rapportés, y compris un
`costCents` attaché à une exception. `actual_cost_cents` additionne les coûts
rapportés des tentatives échouées puis de la réussite ; le résultat garde le coût
de sa propre tentative. Une exception sans mesure porte `costKnown: false`.
Le budget du harness ne prouve pas une mesure complète en cents : sans indication
explicite, son résultat porte aussi `costKnown: false`. Les coûts non rapportés
restent inconnus ; le cumul peut donc sous-estimer la dépense réelle. Ce correctif
ne convertit pas les crédits d’inférence en cents et ne modifie pas les débits,
le financement, Ollama ou le routage des providers.

## Crédits et performance du contexte

Le solde Conway confirmé nul vaut `0` ; `-1` indique un solde inconnu ou non
interrogé. Ollama local est un mode d’inférence gratuit, distinct du solde : la
boucle et le heartbeat conservent `-1` pour les crédits non interrogés, sans
appliquer les restrictions financières à l’inférence locale. Le routage de la
boucle et le contexte heartbeat utilisent alors le tier `normal`.
Les recharges automatiques de la boucle et du heartbeat sont bloquées pour
Ollama local et pour un solde inconnu. Une indisponibilité de l’API n’efface pas
le délai de grâce commencé avec un solde confirmé nul. Hors Ollama local, un
solde confirmé nul conserve le tier `critical` et les règles de recharge.
La classification numérique existante associe toujours un solde négatif au tier
`dead` ; les gardes explicites empêchent de traiter la sentinelle `-1` comme une
preuve de dette ou comme un motif de recharge automatique.

Le profil borné antérieur de `js-tiktoken` observait 1 229 ms pour 5 000 caractères
répétés ; 50 000 et 500 000 dépassaient 10 secondes chacun. Pour une entrée de
plus de 4 096 caractères, `createTokenCounter` utilise désormais le nombre
d’octets UTF-8 comme borne supérieure : chaque token BPE contient au moins un
octet. Le texte reste intact, les protections ne sont pas désactivées, et les
longues entrées ne sont pas retenues dans le cache. Cette borne peut surestimer
sensiblement les tokens et provoquer une compression plus précoce. Les petites
entrées conservent le tokenizer exact et le cache. Le test de régression compare
la borne au tokenizer sur des entrées ASCII et Unicode et vérifie les grandes
entrées sans rétention. `context-hardening.test.ts` n’a pas été modifié.

## Validation

Les résultats ci-dessous décrivent les passages historiques de validation avant
la séparation des commits et la correction finale des crédits. Ils ne constituent
pas un nouveau passage complet sur les trois commits.

Résultats du passage historique complet : **67 suites réussies, 1 739 tests réussis, 0 échoué,
0 ignoré, aucune suite non exécutée ou non terminée**. Le passage complet a
terminé en 23,36 secondes, code 0. Les passages intermédiaires ne sont pas
additionnés.

Commande des régressions ciblées, incluant heartbeat et finances :

```sh
pnpm exec vitest run src/__tests__/integration/worker-protocol.test.ts src/__tests__/orchestration/workspace-publication.test.ts src/__tests__/memory/context-manager.test.ts src/__tests__/heartbeat-scheduler.test.ts src/__tests__/financial.test.ts src/__tests__/funding.test.ts src/__tests__/low-compute.test.ts --reporter=dot
```

Résultat ciblé : **7 suites, 131 réussis, 0 échoué, 0 ignoré**, code 0.
Détail : worker-protocol 28, workspace-publication 8, context-manager 26,
heartbeat-scheduler 23, financial 23, funding 3, low-compute 20.

Commande séparée de context-hardening, bornée à 120 secondes :

```sh
timeout --signal=INT --kill-after=5s 120s pnpm exec vitest run src/__tests__/context-hardening.test.ts --reporter=verbose
```

Résultat : **29 réussis, 0 échoué, 0 ignoré**, suite terminée en 681 ms, code 0.
Le dépassement de délai antérieur n’est plus reproduit sur ce passage.

Commande complète, incluant toutes les 25 suites auparavant restantes :

```sh
timeout --signal=INT --kill-after=5s 180s pnpm exec vitest run --reporter=dot
```

Les premiers passages ciblés ont rencontré deux attentes devenues incompatibles
avec le backoff ou l’ordre des messages, puis trois erreurs liées à la projection
SQL d’un champ absent dans une fixture ancienne et une attente d’ack après erreur
de handler. La projection est maintenant compatible avec cette fixture ; les
attentes de retry/ack reflètent le protocole demandé, et le lot de 201 messages
utilise des identifiants ordonnés pour être déterministe. Aucun test n’a été
supprimé. Les résultats finaux remplacent ces passages pour la validation.

Les limites résiduelles sont l’isolation incomplète des effets externes et shells,
la neutralisation manuelle des affectations historiques, les coûts non mesurés,
la rétention sans purge, la compression éventuellement plus précoce et
l’intervention nécessaire sur les quarantaines. Une base totalement indisponible
ne permet pas d’enregistrer une stratégie durable de reprise.

## Commits et validation des sélections

Les trois commits suivants existent :

- `999811c fix worker task recovery durability`
- `5f930cd fix local ollama credit handling`
- `d568fe4 optimize context token estimation`

La sélection worker/task recovery a été testée dans une copie isolée de
`HEAD + index` avant son commit : **16 suites, 410 tests réussis**, code 0.
Après correction des crédits Ollama, la sélection correspondante a été testée
dans une autre copie isolée : **8 suites, 166 tests réussis**, code 0, incluant
heartbeat, boucle, finances, funding, low-compute et trois suites worker.
`pnpm exec tsc --noEmit` a terminé avec le code 0 sur cette seconde sélection.
Les contrôles `git diff --cached --check` des trois sélections ont terminé avec
le code 0 avant leurs commits. Aucun nouveau passage de tests dédié au commit
tokenizer n’a été exécuté lors de sa préparation ; les résultats du tokenizer
et de context-hardening cités plus haut appartiennent au passage historique.

Les validations décrites ne constituent pas une garantie de confinement des
shells ou des effets externes déjà engagés. Une telle garantie exige encore
l’architecture isolée décrite plus haut. Les limites techniques documentées
restent applicables après ces commits.
