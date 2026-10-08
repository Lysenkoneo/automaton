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
