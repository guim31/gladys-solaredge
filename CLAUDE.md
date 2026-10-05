# CLAUDE.md — SolarEdge

Production solaire, consommation, échanges réseau et batterie depuis SolarEdge.

Intégration externe pour [Gladys Assistant](https://gladysassistant.com), bâtie sur le template officiel `GladysAssistant/integration-template-js` (SDK `@gladysassistant/integration-sdk` ^0.14.0, `gladys_version` `>=5.1.0`). Mainteneur : Guilhem (`guim31`).

Ce fichier rassemble ce qu'une session de code doit savoir et qui ne se lit pas dans le code : choix de conception, faits vérifiés en réel, pièges déjà payés. Le compléter quand un nouveau piège est découvert.

## État au 05/10/2026

Version 1.0.4 publiée, indexée dans le store, sans widget (SDK 0.9, Gladys ≥ 4.62).

La branche `feat/dashboard-widgets` (PR brouillon « feat: dashboard widgets (Gladys 5.1) ») monte
le SDK en ^0.14.0, `gladys_version` en `>=5.1.0`, et ajoute trois widgets : `energy_flow`,
`production`, `battery`. **Rien n'a été vérifié en réel** : ni instance Gladys 5.1, ni compte
SolarEdge dans la session. À confirmer par Guilhem : le rendu des tuiles liées, l'échelle du
graphique à trois séries (W signés), le toast du bouton _Actualiser_, et que la mise à jour depuis
une 1.0.4 (cœur ≥ 5.1) ne casse rien. Une Release `minor` est le geste attendu : le passage à
`>=5.1.0` coupe les mises à jour des cœurs plus anciens.

## Choix de conception (widgets)

- **Un widget ne coûte jamais de requête SolarEdge.** Chaque tableau de bord ouvert tire le
  contenu ; `onWidgetGet` lit `service.lastSnapshot` (le cache, sans rafraîchir) et lie tuiles et
  graphiques aux `external_id` publiés (`device_feature` / `device_features`) : le cœur les anime
  depuis son propre historique. Seul le bouton _Actualiser_ appelle l'API, par la logique de
  `refresh_now` et donc sous le budget du client ; un budget épuisé répond par un toast
  (`WIDGET_ACTIONS.refresh` attrape l'erreur et renvoie `describeError`, déplacé dans
  `src/actions.js` pour cela).
- **Builders purs dans `src/widgets.js`** : entrée `{ features, snapshot, currency, timeZone }` +
  `settings`, sortie un contenu. `index.js` ne fait que câbler (`widgetView()`). Chaque blueprint
  expose `featureIds(gladys, ctx)` (tous les ids possibles ; seuls ceux toujours déclarés sont
  liés : jamais le revenu ni la télémétrie batterie, qui dépendent des capacités et de la config).
- **Textes en objets `{ en, fr }`**, pas de localisation d'après `language` : le cœur choisit, et
  met en cache par langue de toute façon. Les nombres sont formatés dans les deux langues sans
  séparateur de milliers (`useGrouping: false`) et la devise est posée à la main (`€3.21` /
  `3,21 €`) : **la sortie d'`Intl` pour le français change entre versions d'ICU** (U+00A0 puis
  U+202F comme séparateur de milliers, espace fine avant le symbole monétaire), ce qui casserait
  les tests entre Node 22 (session) et Node 24 (CI).
- `energy_flow` tient **exactement** dans le budget du cœur (4 tuiles + graphique + status +
  légende + bouton = 8) : ajouter un composant en fait tomber un autre, en ordre de contenu.
- L'heure « Actualisé à » est celle du **fuseau du site** (`site.location.timeZone`), comme le
  reste de l'intégration, repli sur `TZ` du conteneur si inconnu.
- `nudgeWidgets(snapshot)` appelle `requestWidgetRefresh` pour les trois widgets à chaque
  **nouveau** `fetchedAt` (un seul nudge par lecture, pas un par appareil) : les lignes du status
  suivent la lecture sans attendre le `ttl_seconds` de 300 s. Les états vides (`Aucune batterie…`)
  ont un TTL de 3600 s.
- Les réglages `interval` sont des `select` dont les valeurs sont **le sous-ensemble** de
  `WIDGET_CHART_INTERVALS` que les constantes exportées acceptent ; `pickInterval` retombe sur
  `last-day` pour toute autre valeur (un tableau de bord ancien).

## SDK 0.9 → 0.14 (vérifié en session, le 05/10/2026)

Aucun export ni méthode retiré, aucune signature changée parmi celles utilisées ici (`onAction`,
`onPoll`, `onScanRequest`, `onConfigUpdated`, `publishStates`, `publishState`,
`publishTransports`, `setConnectionStatus`, `externalIds`, `handleShutdown`, `getConfig`,
`publishDiscoveredDevices`). Ajouts : `onWidgetGet`, `onWidgetAction`, `onWidgetGetImage`,
`requestWidgetRefresh`, `onSceneAction`, `publishSceneEvent`, météo, `wakeOnLan`, `getHouses` ;
constantes `WIDGET_*`, `validateWidgetContent`, `validateWidgetImage` ; nouvelles catégories
(`BATTERY_STORAGE`, `GRID_SENSOR`, `HOME_OUTPUT_SENSOR`…) et types (`ENERGY_PRODUCTION_SENSOR.POWER`,
`BATTERY.CHARGING`, `TEXT.SELECT`) — les catégories actuelles des appareils restent valides, et
les changer casserait les appareils existants (fonctionnalités figées). Les 99 tests d'origine
passent sans modification.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test` (`node --test`). Prettier contrôle **aussi le Markdown** : lancer `npm run format`
  après avoir modifié ce fichier ou le README, sinon la CI tombe.
- La CI tourne en Node 24. Une session cloud a Node 22 par défaut, ce qui suffit (`engines` :
  `>=20`).
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel passe par
  Guilhem ou par les testeurs du forum. Le dire, plutôt que de conclure que « ça marche ».
- **Publier est un geste de Guilhem** : Actions → Release (patch, minor ou major) construit
  l'image `ghcr.io/guim31/<dépôt>`, monte la version du manifeste et pose le tag. Un correctif
  poussé sur `main` sans Release n'atteint aucune installation : le signaler.
- Le workflow Release reformate le manifeste avec Prettier, publie l'image et crée la **release
  GitHub** (notes générées depuis les PR, ou `.github/release-notes/vX.Y.Z.md` s'il existe) : c'est
  elle que Gladys ouvre par « Voir le changelog de cette version ». Les trois workflows (`ci`,
  `build`, `release`) sont communs aux intégrations de guim31 : ne pas les modifier dans un seul dépôt.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.
- Le validateur du store (`npx -y github:GladysAssistant/integration-store`) exige Node ≥ 24 dans
  son `engines` mais tourne en Node 22 (avertissement `EBADENGINE` sans conséquence). Il signale
  l'absence de `categories` dans le manifeste : avertissement connu, non bloquant.

## Pièges du cœur Gladys (communs aux intégrations de guim31)

Vérifiés dans le code du cœur ou payés sur une intégration publiée. Ils valent pour toutes.

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe (1000, 2000, 10000, 15000, 30000, 60000 ms).
  Publier seulement `poll_frequency` donne un appareil accepté mais jamais interrogé. Pour une
  cadence hors liste, publier `should_poll: false` et pousser les états depuis le conteneur, en
  gardant un `onPoll` de repli.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié (`getDeviceFeatureName` du front).
- Depuis Gladys 4.84, un changement de structure fait proposer « Mettre à jour » dans l'onglet
  Découverte (`structure_changed`) : plus besoin de supprimer et recréer l'appareil. Un
  changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language`. Le superviseur injecte `TZ`, le
  fuseau de Gladys, dans le conteneur. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus en `<input type="number" min max>` **sans `step`** (le
  manifeste n'en accepte pas) : le navigateur n'accepte alors que `min + k`. Min et défaut
  **entiers** seulement ; une valeur décimale passe par un `select` ou par un `string` parsé
  (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir (la saisie
  s'efface à chaque frappe), et une action n'applique **aucun `default`**, ni à l'affichage ni
  côté serveur, tout en exigeant les champs `required` (422).
- Une action ou une action de widget qui **lève** n'envoie à Gladys qu'une chaîne
  (`error: e.message`, SDK `_runHandler`) : un message bilingue doit être **résolu**, pas levé
  (`NOT_CONFIGURED_MESSAGE`, `describeError` dans `src/actions.js`). Une erreur en français seul
  levée depuis `refreshAll` donnait un toast anglais mélangé : d'où le code `NOT_READY`.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- Budget du cœur : **8 composants par widget, dont 2 textes au plus**. Le validateur du SDK le
  signale ; `validateWidgetContent` est exporté pour les tests.
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées, ce que fait
  le bouton dans ses paramètres.
- Le vocabulaire des widgets n'a ni liste ni curseur. Seul un bouton `device_feature` numérique
  a un état actif natif.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil (Kp > 6) reste le travail
  d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- Passer `gladys_version` à `>=5.1.0` coupe les mises à jour des cœurs plus anciens, qui
  refusent les champs inconnus du manifeste.
- `validateWidgetContent` (SDK 0.14) : un `status` sans ligne est refusé (ne pas l'émettre), un
  `interval` hors liste est ignoré (donc `last-day`), un `ttl_seconds` hors 10–3600 est borné,
  une valeur de status > 40 caractères tronquée. Une `gauge` liée (`device_feature`) prend les
  bornes de la fonctionnalité : ne pas répéter `min`/`max`.
- Un `button` sans `style` est accepté : c'est la forme à préférer (pas de `primary`).

## Publication et store

- Avant de demander une Release ou le topic, lancer le validateur officiel depuis la racine :
  `npx -y github:GladysAssistant/integration-store`. Il vérifie le schéma, la `description`
  (**100 caractères au plus par langue**), la documentation (300 caractères au moins), l'image
  Docker et la cover (**150 Ko au plus**).
- Le topic `gladys-assistant-integration` fait indexer le dépôt ; Guilhem le pose (le jeton de
  l'agent n'en a pas le droit). L'indexeur passe à H:13 chaque heure, souvent avec une demi-heure
  de retard, et rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  l'index `https://integration-store-storage.gladysassistant.com/index.json`.
- Sans topic, on installe par la carte « Installer depuis GitHub » (URL du dépôt, Gladys ≥ 4.84) :
  le cœur lit le manifeste sur `main` et propose les mises à jour à chaque rafraîchissement du
  catalogue.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi. Avant de pousser un dépôt neuf, tester sur
  un `git clone` propre, pas sur la copie de travail.
