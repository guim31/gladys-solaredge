# SolarEdge

Cette intégration connecte votre installation photovoltaïque **SolarEdge** à
Gladys Assistant. Elle lit l'API SolarEdge Monitoring (le même service que
l'application mobile) et crée dans Gladys jusqu'à quatre appareils : la
production solaire, la consommation de la maison, les échanges avec le réseau
et la batterie domestique.

Aucun matériel supplémentaire n'est nécessaire : tout passe par le cloud
SolarEdge, en lecture seule. L'intégration ne pilote rien sur votre onduleur.

## Ce que vous obtenez

Les appareils créés dépendent de ce que votre installation sait remonter :
seuls les sites équipés d'un compteur de consommation (compteur Modbus
SolarEdge) exposent la consommation et le réseau, et seuls les sites équipés
d'une batterie exposent l'appareil batterie. L'intégration détecte tout cela
toute seule au démarrage.

### SolarEdge — Production solaire

Toujours créé.

| Mesure                | Unité | Description                                    |
| --------------------- | ----- | ---------------------------------------------- |
| Puissance produite    | W     | Production instantanée des panneaux            |
| Production du jour    | kWh   | Énergie produite depuis minuit                 |
| Production du mois    | kWh   | Énergie produite depuis le début du mois       |
| Production de l'année | kWh   | Énergie produite depuis le début de l'année    |
| Production totale     | kWh   | Compteur depuis la mise en service             |
| Revenu du jour        | € / $ | Revenu calculé par SolarEdge selon votre tarif |

### SolarEdge — Consommation

Créé si votre installation dispose d'un compteur de consommation.

| Mesure                   | Unité | Description                                   |
| ------------------------ | ----- | --------------------------------------------- |
| Puissance consommée      | W     | Consommation instantanée de la maison         |
| Consommation du jour     | kWh   | Énergie consommée depuis minuit               |
| Autoconsommation du jour | kWh   | Part couverte par les panneaux et la batterie |

### SolarEdge — Réseau

Créé si votre installation mesure les échanges avec le réseau.

| Mesure                   | Unité | Description                                                  |
| ------------------------ | ----- | ------------------------------------------------------------ |
| Puissance réseau         | W     | **Positive** si vous soutirez, **négative** si vous injectez |
| Énergie soutirée du jour | kWh   | Énergie achetée au réseau depuis minuit                      |
| Énergie injectée du jour | kWh   | Surplus revendu depuis minuit                                |

Le signe de la puissance réseau est ce qui rend les scènes intéressantes :
« quand la puissance réseau descend sous −1000 W, allume le chauffe-eau »
signifie exactement « utilise le surplus au lieu de le revendre ».

### SolarEdge — Batterie

Créé si votre site est équipé d'une batterie (SolarEdge Energy Bank, LG RESU…).

| Mesure                 | Unité | Description                                      |
| ---------------------- | ----- | ------------------------------------------------ |
| Niveau de charge       | %     | État de charge de la batterie                    |
| Puissance batterie     | W     | **Positive** en charge, **négative** en décharge |
| État de la batterie    | texte | En charge / En décharge / Au repos / Désactivée  |
| Batterie faible        | 0-1   | Indicateur « critique » remonté par SolarEdge    |
| Énergie stockée\*      | kWh   | Énergie réellement disponible dans la batterie   |
| Température batterie\* | °C    | Température interne du pack                      |

\* Uniquement si l'option **Télémétrie détaillée de la batterie** est activée.

## Configuration

### 1. Obtenir une clé d'API SolarEdge

La clé se génère depuis le portail de supervision SolarEdge, avec un compte
ayant les droits d'administration sur le site :

1. Connectez-vous sur <https://monitoring.solaredge.com/>.
2. Ouvrez **Admin** → **Accès au site** (_Site Access_) → **Accès API**
   (_API Access_).
3. Acceptez les conditions d'utilisation, puis cliquez sur **Générer une
   nouvelle clé** et **Enregistrer**.
4. Copiez la clé (32 caractères en majuscules) ainsi que l'**identifiant du
   site** affiché sur la même page.

Si le menu « Accès API » n'apparaît pas, c'est que votre compte n'a pas le
rôle administrateur sur l'installation : demandez-le à votre installateur.

### 2. Renseigner l'intégration

1. Ouvrez l'onglet **Configuration** de l'intégration dans Gladys.
2. Collez votre **clé d'API**.
3. Laissez **Identifiant du site** vide si votre clé ne couvre qu'un seul
   site : il est détecté automatiquement. Sinon, utilisez le bouton
   **Lister mes sites** pour connaître l'identifiant à saisir.
4. Enregistrez, puis appuyez sur **Tester la connexion**. Le message affiché
   sous le bouton confirme le nom du site et la liste des appareils
   disponibles.
5. Les appareils apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés.

### 3. Régler le rythme de rafraîchissement

SolarEdge limite chaque clé d'API à **300 requêtes par jour et par site**. Une
fois ce quota dépassé, l'API refuse tout jusqu'au lendemain — l'intégration
s'arrête donc d'elle-même avant de l'atteindre.

Le budget se lit ainsi :

- chaque cycle de rafraîchissement coûte **2 requêtes**, quel que soit le
  nombre d'appareils créés (ils partagent tous la même lecture) ;
- le **bilan quotidien** (consommation, autoconsommation, énergie soutirée et
  injectée) coûte **1 requête** à sa propre cadence, plus lente ;
- la **télémétrie détaillée de la batterie**, si vous l'activez, coûte
  **1 requête** de plus à la cadence du bilan quotidien.

Avec les valeurs par défaut (15 min pour les valeurs instantanées, 30 min pour
le bilan), l'intégration consomme environ **240 requêtes par jour** : elle
reste dans le budget avec de la marge.

Si vous descendez l'intervalle à 5 minutes, comptez environ 620 requêtes par
jour : le quota sera atteint en milieu de journée et les valeurs se figeront
jusqu'au lendemain. Le bouton **Consommation de l'API** vous dit à tout moment
où vous en êtes.

> **Pourquoi les appareils affichent « toutes les minutes » ?** Gladys ne sait
> réveiller une intégration qu'à des cadences prédéfinies, dont la plus lente
> est une minute. Ce réveil est un simple battement : il ne coûte aucune
> requête. C'est votre réglage **Intervalle de rafraîchissement** qui décide si
> le battement interroge réellement SolarEdge ou se contente de la dernière
> lecture en cache.

## Actions disponibles

- **Tester la connexion** — vérifie la clé, résout le site et liste les
  appareils que votre installation sait alimenter.
- **Lister mes sites** — affiche tous les sites accessibles avec la clé et
  leur identifiant, à recopier dans le réglage correspondant.
- **Rafraîchir maintenant** — interroge SolarEdge immédiatement, sans attendre
  le prochain cycle.
- **Consommation de l'API** — nombre de requêtes utilisées aujourd'hui et
  nombre de rafraîchissements restants.

## Dépannage

**« SolarEdge a refusé la clé d'API »** — la clé est invalide, a été
régénérée, ou ne donne pas accès à ce site. Régénérez-la depuis le portail et
collez-la à nouveau (attention aux espaces en fin de ligne, l'intégration les
retire d'elle-même).

**« Ce site n'est pas trouvé » ou plusieurs sites** — votre clé couvre
plusieurs installations : appuyez sur **Lister mes sites** et recopiez
l'identifiant voulu dans le réglage **Identifiant du site**.

**Les appareils Consommation et Réseau n'apparaissent pas** — votre
installation n'a pas de compteur de consommation. C'est une option matérielle
(compteur Modbus) posée par l'installateur ; sans elle, SolarEdge ne connaît
que la production.

**Les valeurs ne bougent plus dans l'après-midi** — le quota quotidien est
probablement atteint. Vérifiez avec **Consommation de l'API** et augmentez
l'intervalle de rafraîchissement. Une pastille orange apparaît alors sur les
appareils pour signaler que les valeurs ne sont plus rafraîchies.

**Un badge « injoignable » sur les appareils** — le cloud SolarEdge ne répond
pas. L'intégration réessaie automatiquement ; les logs de l'intégration
(`LOG_LEVEL=debug` pour le détail) indiquent la cause exacte.

## Vie privée

L'intégration ne communique qu'avec `monitoringapi.solaredge.com`, en lecture
seule. Votre clé d'API est stockée par Gladys comme un secret et n'est jamais
renvoyée à l'interface. Aucune donnée n'est envoyée ailleurs.
