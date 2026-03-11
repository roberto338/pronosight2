// ══════════════════════════════════════════════
// config.js — Constants & Leagues
// ══════════════════════════════════════════════

export const CACHE_TTL = 15 * 60 * 1000;         // 15 min for match lists
export const ANALYSIS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6h for analyses

export const CUP_IDS = ['ucl','uel','uecl','coparey','libertadores','sudamericana','cafcl','can','coupefrance','facup','leaguecup','copaitalia','dfbpokal','natleague','wc2026','cwc'];

export const BOOKMAKERS_EU = ['bet365','unibet','betclic','winamax','betway','pinnacle','williamhill','bwin'];

export const LEAGUES = [
  {id:'ligue1',flag:'🇫🇷',name:'Ligue 1',tier:'D1',sport:'football',cat:'europe-top',country:'France'},
  {id:'pl',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'Premier League',tier:'D1',sport:'football',cat:'europe-top',country:'Angleterre'},
  {id:'laliga',flag:'🇪🇸',name:'La Liga',tier:'D1',sport:'football',cat:'europe-top',country:'Espagne'},
  {id:'bundesliga',flag:'🇩🇪',name:'Bundesliga',tier:'D1',sport:'football',cat:'europe-top',country:'Allemagne'},
  {id:'seriea',flag:'🇮🇹',name:'Serie A',tier:'D1',sport:'football',cat:'europe-top',country:'Italie'},
  {id:'ligue2',flag:'🇫🇷',name:'Ligue 2',tier:'D2',sport:'football',cat:'europe-d2',country:'France'},
  {id:'championship',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'Championship',tier:'D2',sport:'football',cat:'europe-d2',country:'Angleterre'},
  {id:'liga2',flag:'🇪🇸',name:'Liga Adelante',tier:'D2',sport:'football',cat:'europe-d2',country:'Espagne'},
  {id:'bundesliga2',flag:'🇩🇪',name:'2. Bundesliga',tier:'D2',sport:'football',cat:'europe-d2',country:'Allemagne'},
  {id:'serieb',flag:'🇮🇹',name:'Serie B',tier:'D2',sport:'football',cat:'europe-d2',country:'Italie'},
  {id:'leagueone',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'League One',tier:'D3',sport:'football',cat:'europe-d2',country:'Angleterre'},
  {id:'leaguetwo',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'League Two',tier:'D4',sport:'football',cat:'europe-d2',country:'Angleterre'},
  {id:'eredivisie',flag:'🇳🇱',name:'Eredivisie',tier:'D1',sport:'football',cat:'europe-other',country:'Pays-Bas'},
  {id:'proleague',flag:'🇧🇪',name:'Pro League',tier:'D1',sport:'football',cat:'europe-other',country:'Belgique'},
  {id:'superleaguech',flag:'🇨🇭',name:'Super League',tier:'D1',sport:'football',cat:'europe-other',country:'Suisse'},
  {id:'superlig',flag:'🇹🇷',name:'Süper Lig',tier:'D1',sport:'football',cat:'europe-other',country:'Turquie'},
  {id:'primeiraliga',flag:'🇵🇹',name:'Primeira Liga',tier:'D1',sport:'football',cat:'europe-other',country:'Portugal'},
  {id:'ekstraklasa',flag:'🇵🇱',name:'Ekstraklasa',tier:'D1',sport:'football',cat:'europe-other',country:'Pologne'},
  {id:'allsvenskan',flag:'🇸🇪',name:'Allsvenskan',tier:'D1',sport:'football',cat:'europe-other',country:'Suède'},
  {id:'eliteserien',flag:'🇳🇴',name:'Eliteserien',tier:'D1',sport:'football',cat:'europe-other',country:'Norvège'},
  {id:'veikkausliiga',flag:'🇫🇮',name:'Veikkausliiga',tier:'D1',sport:'football',cat:'europe-other',country:'Finlande'},
  {id:'superligadk',flag:'🇩🇰',name:'Superliga',tier:'D1',sport:'football',cat:'europe-other',country:'Danemark'},
  {id:'hnl',flag:'🇭🇷',name:'HNL',tier:'D1',sport:'football',cat:'europe-other',country:'Croatie'},
  {id:'fortunaliga',flag:'🇸🇰',name:'Fortuna Liga',tier:'D1',sport:'football',cat:'europe-other',country:'Slovaquie'},
  {id:'nb1',flag:'🇭🇺',name:'Nemzeti Bajnokság',tier:'D1',sport:'football',cat:'europe-other',country:'Hongrie'},
  {id:'superligars',flag:'🇷🇸',name:'SuperLiga',tier:'D1',sport:'football',cat:'europe-other',country:'Serbie'},
  {id:'upl',flag:'🇺🇦',name:'Premier League',tier:'D1',sport:'football',cat:'europe-other',country:'Ukraine'},
  {id:'rpl',flag:'🇷🇺',name:'RPL',tier:'D1',sport:'football',cat:'europe-other',country:'Russie'},
  {id:'scottish',flag:'🏴󠁧󠁢󠁳󠁣󠁴󠁿',name:'Scottish Prem.',tier:'D1',sport:'football',cat:'europe-other',country:'Écosse'},
  {id:'coupefrance',flag:'🇫🇷',name:'Coupe de France',tier:'Coupe',sport:'football',cat:'cups',country:'France'},
  {id:'facup',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'FA Cup',tier:'Coupe',sport:'football',cat:'cups',country:'Angleterre'},
  {id:'leaguecup',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',name:'League Cup (Carabao)',tier:'Coupe',sport:'football',cat:'cups',country:'Angleterre'},
  {id:'copaitalia',flag:'🇮🇹',name:'Coppa Italia',tier:'Coupe',sport:'football',cat:'cups',country:'Italie'},
  {id:'dfbpokal',flag:'🇩🇪',name:'DFB-Pokal',tier:'Coupe',sport:'football',cat:'cups',country:'Allemagne'},
  {id:'coparey',flag:'🇪🇸',name:'Copa del Rey',tier:'Coupe',sport:'football',cat:'cups',country:'Espagne'},
  {id:'natleague',flag:'🇪🇺',name:'Ligue des Nations',tier:'Coupe',sport:'football',cat:'cups',country:'Europe'},
  {id:'wc2026',flag:'🌍',name:'Coupe du Monde 2026',tier:'Coupe',sport:'football',cat:'cups',country:'Monde'},
  {id:'cwc',flag:'🌍',name:'Club World Cup',tier:'Coupe',sport:'football',cat:'cups',country:'Monde'},
  {id:'ucl',flag:'🏆',name:'Champions League',tier:'Coupe',sport:'football',cat:'cups',country:'Europe'},
  {id:'uel',flag:'🥈',name:'Europa League',tier:'Coupe',sport:'football',cat:'cups',country:'Europe'},
  {id:'uecl',flag:'🥉',name:'Conference League',tier:'Coupe',sport:'football',cat:'cups',country:'Europe'},
  {id:'mls',flag:'🇺🇸',name:'MLS',tier:'D1',sport:'football',cat:'americas',country:'USA'},
  {id:'ligamx',flag:'🇲🇽',name:'Liga MX',tier:'D1',sport:'football',cat:'americas',country:'Mexique'},
  {id:'brasileirao',flag:'🇧🇷',name:'Brasileirao A',tier:'D1',sport:'football',cat:'americas',country:'Brésil'},
  {id:'brasileiraob',flag:'🇧🇷',name:'Brasileirao B',tier:'D2',sport:'football',cat:'americas',country:'Brésil'},
  {id:'primeradiv',flag:'🇦🇷',name:'Primera División',tier:'D1',sport:'football',cat:'americas',country:'Argentine'},
  {id:'primerachile',flag:'🇨🇱',name:'Primera División',tier:'D1',sport:'football',cat:'americas',country:'Chili'},
  {id:'liga1peru',flag:'🇵🇪',name:'Liga 1',tier:'D1',sport:'football',cat:'americas',country:'Pérou'},
  {id:'ligabetplay',flag:'🇨🇴',name:'Liga BetPlay',tier:'D1',sport:'football',cat:'americas',country:'Colombie'},
  {id:'libertadores',flag:'🏆',name:'Copa Libertadores',tier:'Coupe',sport:'football',cat:'americas',country:'Amérique du Sud'},
  {id:'sudamericana',flag:'🥈',name:'Copa Sudamericana',tier:'Coupe',sport:'football',cat:'americas',country:'Amérique du Sud'},
  {id:'jleague',flag:'🇯🇵',name:'J-League',tier:'D1',sport:'football',cat:'asia',country:'Japon'},
  {id:'kleague',flag:'🇰🇷',name:'K-League',tier:'D1',sport:'football',cat:'asia',country:'Corée'},
  {id:'csl',flag:'🇨🇳',name:'Chinese Super League',tier:'D1',sport:'football',cat:'asia',country:'Chine'},
  {id:'aleague',flag:'🇦🇺',name:'A-League',tier:'D1',sport:'football',cat:'asia',country:'Australie'},
  {id:'saudipl',flag:'🇸🇦',name:'Saudi Pro League',tier:'D1',sport:'football',cat:'asia',country:'Arabie Saoudite'},
  {id:'uaepro',flag:'🇦🇪',name:'UAE Pro League',tier:'D1',sport:'football',cat:'asia',country:'Émirats'},
  {id:'isl',flag:'🇮🇳',name:'Indian Super League',tier:'D1',sport:'football',cat:'asia',country:'Inde'},
  {id:'can',flag:'🌍',name:'CAN',tier:'Coupe',sport:'football',cat:'africa',country:'Afrique'},
  {id:'cafcl',flag:'🏆',name:'CAF Champions League',tier:'Coupe',sport:'football',cat:'africa',country:'Afrique'},
  {id:'botola',flag:'🇲🇦',name:'Botola Pro',tier:'D1',sport:'football',cat:'africa',country:'Maroc'},
  {id:'algerie1',flag:'🇩🇿',name:'Ligue 1',tier:'D1',sport:'football',cat:'africa',country:'Algérie'},
  {id:'tunisie1',flag:'🇹🇳',name:'Ligue 1',tier:'D1',sport:'football',cat:'africa',country:'Tunisie'},
  {id:'npfl',flag:'🇳🇬',name:'NPFL',tier:'D1',sport:'football',cat:'africa',country:'Nigeria'},
  {id:'psl',flag:'🇿🇦',name:'PSL',tier:'D1',sport:'football',cat:'africa',country:'Afrique du Sud'},
  {id:'nba',flag:'🇺🇸',name:'NBA',tier:'D1',sport:'basket',cat:'usa-basket',country:'USA'},
  {id:'gleague',flag:'🇺🇸',name:'G-League',tier:'D2',sport:'basket',cat:'usa-basket',country:'USA'},
  {id:'ncaa',flag:'🇺🇸',name:'NCAA',tier:'Univ.',sport:'basket',cat:'usa-basket',country:'USA'},
  {id:'wnba',flag:'🇺🇸',name:'WNBA',tier:'D1 F',sport:'basket',cat:'usa-basket',country:'USA'},
  {id:'euroleague',flag:'🏆',name:'EuroLeague',tier:'Coupe',sport:'basket',cat:'euro-basket',country:'Europe'},
  {id:'eurocup',flag:'🥈',name:'EuroCup',tier:'Coupe',sport:'basket',cat:'euro-basket',country:'Europe'},
  {id:'proa',flag:'🇫🇷',name:'Betclic Élite',tier:'D1',sport:'basket',cat:'euro-basket',country:'France'},
  {id:'prob',flag:'🇫🇷',name:'Pro B',tier:'D2',sport:'basket',cat:'euro-basket',country:'France'},
  {id:'acb',flag:'🇪🇸',name:'ACB Liga',tier:'D1',sport:'basket',cat:'euro-basket',country:'Espagne'},
  {id:'legabasket',flag:'🇮🇹',name:'Lega Basket A',tier:'D1',sport:'basket',cat:'euro-basket',country:'Italie'},
  {id:'bbl',flag:'🇩🇪',name:'BBL',tier:'D1',sport:'basket',cat:'euro-basket',country:'Allemagne'},
  {id:'lkl',flag:'🇱🇹',name:'LKL',tier:'D1',sport:'basket',cat:'euro-basket',country:'Lituanie'},
  {id:'bsl',flag:'🇹🇷',name:'BSL',tier:'D1',sport:'basket',cat:'euro-basket',country:'Turquie'},
  {id:'vtb',flag:'🇷🇺',name:'VTB United League',tier:'D1',sport:'basket',cat:'euro-basket',country:'Russie'},
  {id:'nblpl',flag:'🇵🇱',name:'NBL Pologne',tier:'D1',sport:'basket',cat:'euro-basket',country:'Pologne'},
  {id:'basketgr',flag:'🇬🇷',name:'Basket League',tier:'D1',sport:'basket',cat:'euro-basket',country:'Grèce'},
  {id:'euromillions',flag:'🇧🇪',name:'EuroMillions League',tier:'D1',sport:'basket',cat:'euro-basket',country:'Belgique'},
  {id:'nbbr',flag:'🇧🇷',name:'NBB Brésil',tier:'D1',sport:'basket',cat:'world-basket',country:'Brésil'},
  {id:'nblau',flag:'🇦🇺',name:'NBL Australie',tier:'D1',sport:'basket',cat:'world-basket',country:'Australie'},
  {id:'cba',flag:'🇨🇳',name:'CBA Chine',tier:'D1',sport:'basket',cat:'world-basket',country:'Chine'},
  {id:'fibawc',flag:'🌍',name:'FIBA World Cup',tier:'Mondial',sport:'basket',cat:'world-basket',country:'Monde'}
];

export const CATS = {
  football: [
    {id:'all',label:'Tout'},{id:'europe-top',label:'🌟 Top 5'},{id:'europe-d2',label:'🏴 D2/D3'},
    {id:'europe-other',label:'🇪🇺 Europe+'},{id:'cups',label:'🏆 Coupes'},
    {id:'americas',label:'🌎 Amériques'},{id:'asia',label:'🌏 Asie'},{id:'africa',label:'🌍 Afrique'}
  ],
  basket: [
    {id:'all',label:'Tout'},{id:'usa-basket',label:'🇺🇸 USA'},
    {id:'euro-basket',label:'🇪🇺 Europe'},{id:'world-basket',label:'🌍 Monde'}
  ]
};

export const ODDS_SPORT_MAP = {
  'ligue1':'soccer_france_ligue_one','ligue2':'soccer_france_ligue_two',
  'pl':'soccer_epl','championship':'soccer_england_league1',
  'laliga':'soccer_spain_la_liga','liga2':'soccer_spain_segunda_division',
  'bundesliga':'soccer_germany_bundesliga','bundesliga2':'soccer_germany_bundesliga2',
  'seriea':'soccer_italy_serie_a','serieb':'soccer_italy_serie_b',
  'ucl':'soccer_uefa_champs_league','uel':'soccer_uefa_europa_league','uecl':'soccer_uefa_europa_conference_league',
  'eredivisie':'soccer_netherlands_eredivisie','proleague':'soccer_belgium_first_div',
  'superlig':'soccer_turkey_super_ligi','primeiraliga':'soccer_portugal_primeira_liga',
  'scottish':'soccer_scotland_premiership','mls':'soccer_usa_mls',
  'ligamx':'soccer_mexico_ligamx','brasileirao':'soccer_brazil_campeonato',
  'primeradiv':'soccer_argentina_primera_division',
  'jleague':'soccer_japan_j_league','saudipl':'soccer_saudi_professional_league',
  'nba':'basketball_nba','wnba':'basketball_wnba','euroleague':'basketball_euroleague','ncaa':'basketball_ncaab'
};

export const TSDB_LEAGUE_MAP = {
  'ligue1':4334,'ligue2':4333,'coupefrance':4399,
  'pl':4328,'championship':4329,'facup':4390,'leaguecup':4443,
  'laliga':4335,'liga2':4552,'coparey':4397,
  'bundesliga':4331,'bundesliga2':4396,'dfbpokal':4398,
  'seriea':4332,'serieb':4395,'copaitalia':4401,
  'ucl':4480,'uel':4481,'uecl':4882,
  'eredivisie':4337,'proleague':4336,'primeiraliga':4344,
  'superlig':4338,'scottish':4330,'ekstraklasa':4422,
  'allsvenskan':4415,'eliteserien':4347,
  'mls':4346,'brasileirao':4351,'ligamx':4350,'primeradiv':4406,
  'libertadores':4480,
  'nba':4387,'euroleague':4966,'ncaa':4479,
  'natleague':4635,'cwc':4486,'wc2026':4444
};

export const FD_COMP_MAP = {
  'pl':2021,'bundesliga':2002,'seriea':2019,'laliga':2014,'ligue1':2015,
  'ucl':2001,'uel':2146,'facup':2055,'dfbpokal':2011,'eredivisie':2003,
  'primeiraliga':2017,'championship':2016,'mls':2013,
  'coparey':2079,'copaitalia':2107
};

export const TODAY_LEAGUES = [
  {id:'ligue1',name:'Ligue 1',flag:'🇫🇷',tsdb:4334,sport:'soccer'},
  {id:'pl',name:'Premier League',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',tsdb:4328,sport:'soccer'},
  {id:'laliga',name:'La Liga',flag:'🇪🇸',tsdb:4335,sport:'soccer'},
  {id:'bundesliga',name:'Bundesliga',flag:'🇩🇪',tsdb:4331,sport:'soccer'},
  {id:'seriea',name:'Serie A',flag:'🇮🇹',tsdb:4332,sport:'soccer'},
  {id:'ucl',name:'Champions League',flag:'🏆',tsdb:4480,sport:'soccer'},
  {id:'uel',name:'Europa League',flag:'🟠',tsdb:4481,sport:'soccer'},
  {id:'uecl',name:'Conference League',flag:'🔵',tsdb:4882,sport:'soccer'},
  {id:'coupefrance',name:'Coupe de France',flag:'🇫🇷',tsdb:4399,sport:'soccer'},
  {id:'facup',name:'FA Cup',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',tsdb:4390,sport:'soccer'},
  {id:'coparey',name:'Copa del Rey',flag:'🇪🇸',tsdb:4397,sport:'soccer'},
  {id:'dfbpokal',name:'DFB-Pokal',flag:'🇩🇪',tsdb:4398,sport:'soccer'},
  {id:'copaitalia',name:'Coppa Italia',flag:'🇮🇹',tsdb:4401,sport:'soccer'},
  {id:'eredivisie',name:'Eredivisie',flag:'🇳🇱',tsdb:4337,sport:'soccer'},
  {id:'proleague',name:'Pro League',flag:'🇧🇪',tsdb:4336,sport:'soccer'},
  {id:'mls',name:'MLS',flag:'🇺🇸',tsdb:4346,sport:'soccer'},
  {id:'nba',name:'NBA',flag:'🇺🇸',tsdb:4387,sport:'basketball'},
  {id:'euroleague',name:'EuroLeague',flag:'🇪🇺',tsdb:4966,sport:'basketball'}
];
