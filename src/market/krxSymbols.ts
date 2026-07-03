/**
 * Bundled static list of well-known KRX stocks used as the SymbolCatalog source.
 * Toss GET /api/v1/stocks requires explicit `symbols` params — there is no search-all
 * or list-all endpoint — so we ship a curated list and search it locally.
 *
 * Last updated: 2026-07
 */
import type { TossStock } from '../toss/types.js';

export const KRX_SYMBOLS: TossStock[] = [
  { symbol: '005930', name: '삼성전자',        market: 'KR', sector: '반도체',    englishName: 'Samsung Electronics' },
  { symbol: '000660', name: 'SK하이닉스',      market: 'KR', sector: '반도체',    englishName: 'SK Hynix' },
  { symbol: '373220', name: 'LG에너지솔루션',  market: 'KR', sector: '2차전지',   englishName: 'LG Energy Solution' },
  { symbol: '207940', name: '삼성바이오로직스', market: 'KR', sector: '바이오/제약', englishName: 'Samsung Biologics' },
  { symbol: '005380', name: '현대차',           market: 'KR', sector: '자동차',    englishName: 'Hyundai Motor' },
  { symbol: '000270', name: '기아',             market: 'KR', sector: '자동차',    englishName: 'Kia' },
  { symbol: '068270', name: '셀트리온',         market: 'KR', sector: '바이오/제약', englishName: 'Celltrion' },
  { symbol: '035420', name: 'NAVER',            market: 'KR', sector: '인터넷/IT', englishName: 'NAVER' },
  { symbol: '035720', name: '카카오',           market: 'KR', sector: '인터넷/IT', englishName: 'Kakao' },
  { symbol: '105560', name: 'KB금융',           market: 'KR', sector: '금융',      englishName: 'KB Financial Group' },
  { symbol: '055550', name: '신한지주',         market: 'KR', sector: '금융',      englishName: 'Shinhan Financial Group' },
  { symbol: '005490', name: 'POSCO홀딩스',     market: 'KR', sector: '철강',      englishName: 'POSCO Holdings' },
  { symbol: '051910', name: 'LG화학',           market: 'KR', sector: '화학/소재', englishName: 'LG Chem' },
  { symbol: '006400', name: '삼성SDI',          market: 'KR', sector: '2차전지',   englishName: 'Samsung SDI' },
  { symbol: '012330', name: '현대모비스',       market: 'KR', sector: '자동차',    englishName: 'Hyundai Mobis' },
  { symbol: '028260', name: '삼성물산',         market: 'KR', sector: '지주/기타', englishName: 'Samsung C&T' },
  { symbol: '066570', name: 'LG전자',           market: 'KR', sector: '전자/전기', englishName: 'LG Electronics' },
  { symbol: '003670', name: '포스코퓨처엠',    market: 'KR', sector: '2차전지',   englishName: 'POSCO Future M' },
  { symbol: '096770', name: 'SK이노베이션',    market: 'KR', sector: '화학/소재', englishName: 'SK Innovation' },
  { symbol: '034730', name: 'SK',               market: 'KR', sector: '지주/기타', englishName: 'SK Inc.' },
  { symbol: '032830', name: '삼성생명',         market: 'KR', sector: '금융',      englishName: 'Samsung Life Insurance' },
  { symbol: '086790', name: '하나금융지주',    market: 'KR', sector: '금융',      englishName: 'Hana Financial Group' },
  { symbol: '316140', name: '우리금융지주',    market: 'KR', sector: '금융',      englishName: 'Woori Financial Group' },
  { symbol: '033780', name: 'KT&G',             market: 'KR', sector: '엔터/기타', englishName: 'KT&G' },
  { symbol: '017670', name: 'SK텔레콤',        market: 'KR', sector: '엔터/기타', englishName: 'SK Telecom' },
  { symbol: '030200', name: 'KT',               market: 'KR', sector: '엔터/기타', englishName: 'KT Corp' },
  { symbol: '018260', name: '삼성에스디에스',  market: 'KR', sector: '인터넷/IT', englishName: 'Samsung SDS' },
  { symbol: '009150', name: '삼성전기',         market: 'KR', sector: '전자/전기', englishName: 'Samsung Electro-Mechanics' },
  { symbol: '010130', name: '고려아연',         market: 'KR', sector: '화학/소재', englishName: 'Korea Zinc' },
  { symbol: '000810', name: '삼성화재',         market: 'KR', sector: '금융',      englishName: 'Samsung Fire & Marine Insurance' },
  { symbol: '011200', name: 'HMM',              market: 'KR', sector: '해운',      englishName: 'HMM' },
  { symbol: '003550', name: 'LG',               market: 'KR', sector: '지주/기타', englishName: 'LG Corp' },
  { symbol: '267250', name: 'HD현대',           market: 'KR', sector: '조선',      englishName: 'HD Hyundai' },
  { symbol: '047050', name: '포스코인터내셔널', market: 'KR', sector: '지주/기타', englishName: 'POSCO International' },
  { symbol: '036570', name: 'NC소프트',         market: 'KR', sector: '게임',      englishName: 'NCSoft' },
  { symbol: '251270', name: '넷마블',           market: 'KR', sector: '게임',      englishName: 'Netmarble' },
  { symbol: '112040', name: '위메이드',         market: 'KR', sector: '게임',      englishName: 'Wemade' },
  { symbol: '293490', name: '카카오게임즈',    market: 'KR', sector: '게임',      englishName: 'Kakao Games' },
  { symbol: '352820', name: '하이브',           market: 'KR', sector: '엔터/기타', englishName: 'HYBE' },
  { symbol: '041510', name: 'SM엔터테인먼트',  market: 'KR', sector: '엔터/기타', englishName: 'SM Entertainment' },
  { symbol: '247540', name: '에코프로비엠',    market: 'KR', sector: '2차전지',   englishName: 'EcoPro BM' },
  { symbol: '086520', name: '에코프로',        market: 'KR', sector: '2차전지',   englishName: 'EcoPro' },
];
