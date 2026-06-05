const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const USDA_API_KEY = process.env.USDA_API_KEY;

// ── Firebase Admin (토큰 검증용) ──────────────────────────
// npm install firebase-admin 후 사용
// Vercel 환경변수에 FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 추가
let admin = null;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
} catch (e) {
  console.warn('firebase-admin 미설치 또는 환경변수 없음 — 인증 미들웨어 비활성화:', e.message);
}

// 인증 미들웨어 (firebase-admin 설치 후 활성화)
async function requireAuth(req, res, next) {
  // TODO: firebase-admin 설치 후 아래 주석 해제
  // if (!admin) return next();
  // const token = (req.headers.authorization || '').replace('Bearer ', '');
  // if (!token) return res.status(401).json({ error: '로그인이 필요해요' });
  // try { req.user = await admin.auth().verifyIdToken(token); next(); }
  // catch { return res.status(401).json({ error: '인증이 만료됐어요. 다시 로그인해주세요.' }); }
  return next(); // 현재는 프론트 로그인으로만 접근 제어
}
// ─────────────────────────────────────────────────────────

function extractYoutubeId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/shorts\/([^?]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getYoutubeRecipeText(videoId, fetch) {
  let text = '';
  try {
    const videoRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`
    );
    const videoData = await videoRes.json();
    const description = videoData.items?.[0]?.snippet?.description || '';
    text += description;

    const commentRes = await fetch(
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&order=relevance&maxResults=5&key=${YOUTUBE_API_KEY}`
    );
    const commentData = await commentRes.json();
    const comments = commentData.items?.map(
      item => item.snippet.topLevelComment.snippet.textDisplay
    ).join('\n') || '';
    text += '\n' + comments;
  } catch (e) {
    console.log('YouTube API 오류:', e.message);
  }
  return text;
}

// 한국어 재료명을 영어로 번역
async function translateToEnglish(names, fetch) {
  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Translate these food ingredient names to English. Return ONLY a JSON array of strings in the same order, no explanation.
Input: ${JSON.stringify(names)}
Output format: ["english name 1", "english name 2", ...]`
        }],
        temperature: 0
      })
    });
    const data = await gptRes.json();
    const text = data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.log('번역 오류:', e.message);
    return names; // 실패하면 원래 이름 그대로 사용
  }
}

function isKorean(text) {
  return /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
}

// ── 단위 매핑 테이블 (비정형 → g/ml 표준값) ─────────────────────
const UNIT_MAP = {
  // 부피(ml)
  '큰술': { value: 15, unit: 'ml' }, '밥숟가락': { value: 15, unit: 'ml' },
  'tablespoon': { value: 15, unit: 'ml' }, 'tbsp': { value: 15, unit: 'ml' }, 'T': { value: 15, unit: 'ml' },
  '작은술': { value: 5, unit: 'ml' }, '찻숟가락': { value: 5, unit: 'ml' },
  'teaspoon': { value: 5, unit: 'ml' }, 'tsp': { value: 5, unit: 'ml' }, 't': { value: 5, unit: 'ml' },
  '컵': { value: 240, unit: 'ml' }, 'cup': { value: 240, unit: 'ml' }, 'c': { value: 240, unit: 'ml' },
  '반컵': { value: 120, unit: 'ml' }, '반 컵': { value: 120, unit: 'ml' }, 'half cup': { value: 120, unit: 'ml' },
  '1/3컵': { value: 80, unit: 'ml' }, '1/3 컵': { value: 80, unit: 'ml' }, '1/3 cup': { value: 80, unit: 'ml' },
  '1/4컵': { value: 60, unit: 'ml' }, '1/4 컵': { value: 60, unit: 'ml' }, 'quarter cup': { value: 60, unit: 'ml' },
  '종이컵': { value: 180, unit: 'ml' }, 'paper cup': { value: 180, unit: 'ml' },
  '밥공기': { value: 200, unit: 'ml' }, 'rice bowl': { value: 200, unit: 'ml' },
  '국자': { value: 60, unit: 'ml' }, 'ladle': { value: 60, unit: 'ml' },
  'ml': { value: 1, unit: 'ml' }, 'cc': { value: 1, unit: 'ml' },
  'fl oz': { value: 30, unit: 'ml' }, 'fluid ounce': { value: 30, unit: 'ml' },
  '한스푼': { value: 20, unit: 'ml' }, '한 스푼': { value: 20, unit: 'ml' }, 'heaping tablespoon': { value: 20, unit: 'ml' },
  'dash': { value: 1, unit: 'ml' },
  'splash': { value: 5, unit: 'ml' },
  // 무게(g)
  '한줌': { value: 30, unit: 'g' }, '한 줌': { value: 30, unit: 'g' }, 'handful': { value: 30, unit: 'g' }, 'a handful': { value: 30, unit: 'g' },
  '두줌': { value: 60, unit: 'g' }, '두 줌': { value: 60, unit: 'g' }, 'two handfuls': { value: 60, unit: 'g' },
  '한움큼': { value: 40, unit: 'g' }, '한 움큼': { value: 40, unit: 'g' }, 'fistful': { value: 40, unit: 'g' },
  'g': { value: 1, unit: 'g' }, 'gram': { value: 1, unit: 'g' }, 'grams': { value: 1, unit: 'g' },
  'kg': { value: 1000, unit: 'g' }, 'kilogram': { value: 1000, unit: 'g' },
  'oz': { value: 28, unit: 'g' }, 'ounce': { value: 28, unit: 'g' },
  'lb': { value: 454, unit: 'g' }, 'pound': { value: 454, unit: 'g' },
  '묶음': { value: 100, unit: 'g' }, '단': { value: 100, unit: 'g' }, 'bunch': { value: 100, unit: 'g' },
  '통': { value: 400, unit: 'g' }, '캔': { value: 400, unit: 'g' }, 'can': { value: 400, unit: 'g' },
  '쪽': { value: 5, unit: 'g' }, 'clove': { value: 5, unit: 'g' },       // 마늘 1쪽
  '장': { value: 2, unit: 'g' }, 'sheet': { value: 2, unit: 'g' },        // 김 1장
  // 모호한 표현
  '약간': { value: 2, unit: 'g' }, '조금': { value: 2, unit: 'g' }, 'a little': { value: 2, unit: 'g' }, 'a bit': { value: 2, unit: 'g' },
  '적당량': { value: 5, unit: 'g' }, 'to taste': { value: 5, unit: 'g' }, 'as needed': { value: 5, unit: 'g' },
  '듬뿍': { value: 20, unit: 'g' }, 'generously': { value: 20, unit: 'g' },
  '한꼬집': { value: 0.5, unit: 'g' }, '한 꼬집': { value: 0.5, unit: 'g' }, 'pinch': { value: 0.5, unit: 'g' }, 'a pinch': { value: 0.5, unit: 'g' },
};

// 재료 unit을 g/ml로 정규화하고 amount=0인 경우 fallback 처리
function normalizeIngredients(ingredients) {
  return ingredients.map(ing => {
    let { name, amount, unit } = ing;
    const unitKey = (unit || '').trim().toLowerCase();
    const mapped = UNIT_MAP[unitKey] || UNIT_MAP[unit?.trim()] || null;

    if (mapped) {
      // 단위 변환: amount * mapped.value → g 또는 ml 기준
      amount = Math.round((amount || 1) * mapped.value);
      unit = mapped.unit;
    }

    // amount가 0이거나 없으면 기본값 100g으로 fallback
    if (!amount || amount <= 0) {
      amount = 100;
      unit = unit || 'g';
    }

    return { name, amount, unit };
  });
}

async function getNutritionFromUSDA(ingredients, fetch) {
  let totalNutrition = {
    calories: 0, carbs: 0, sugar: 0,
    protein: 0, fat: 0, sodium: 0, cholesterol: 0
  };

  // 단위 정규화 (비정형 → g/ml, amount=0 fallback)
  ingredients = normalizeIngredients(ingredients);

  // 한국어 재료명이 있으면 영어로 번역
  const names = ingredients.map(i => i.name);
  const hasKorean = names.some(n => isKorean(n));
  let searchNames = names;
  if (hasKorean) {
    searchNames = await translateToEnglish(names, fetch);
  }

  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    const searchName = searchNames[i] || ing.name;
    try {
      const res = await fetch(
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(searchName)}&pageSize=1&api_key=${USDA_API_KEY}`
      );
      const data = await res.json();
      const food = data.foods?.[0];
      if (!food) continue;

      const nutrients = food.foodNutrients || [];
      const get = (name) => nutrients.find(n => n.nutrientName?.includes(name))?.value || 0;

      const ratio = (ing.amount || 100) / 100;
      totalNutrition.calories    += (get('Energy') * ratio);
      totalNutrition.carbs       += (get('Carbohydrate') * ratio);
      totalNutrition.sugar       += (get('Sugars') * ratio);
      totalNutrition.protein     += (get('Protein') * ratio);
      totalNutrition.fat         += (get('Total lipid') * ratio);
      totalNutrition.sodium      += (get('Sodium') * ratio / 1000);
      totalNutrition.cholesterol += (get('Cholesterol') * ratio);
    } catch (e) {
      console.log(`USDA 오류 (${ing.name}):`, e.message);
    }
  }

  Object.keys(totalNutrition).forEach(k => {
    totalNutrition[k] = Math.round(totalNutrition[k]);
  });
  totalNutrition.sodium = Math.round(totalNutrition.sodium * 1000);

  return totalNutrition;
}

app.post('/api/extract', requireAuth, async (req, res) => {
  const { url, dietTypes } = req.body;
  const { default: fetch } = await import('node-fetch');

  const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
  const isInstagram = url.includes('instagram.com');

  if (!isYoutube && !isInstagram) {
    return res.status(400).json({ error: 'YouTube 또는 Instagram URL만 가능해요' });
  }

  let recipeText = '';
  let videoTitle = url;

  if (isYoutube) {
    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: '유효하지 않은 YouTube URL이에요' });

    recipeText = await getYoutubeRecipeText(videoId, fetch);

    try {
      const meta = await fetch(`https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${videoId}&format=json`);
      const metaData = await meta.json();
      videoTitle = metaData.title || url;
    } catch (e) {}
  }

  const dietContext = dietTypes && dietTypes.length > 0
    ? dietTypes.join(', ') : 'General healthy diet';

  const prompt = `You are a professional nutritionist and chef AI.

Video title: "${videoTitle}"
Description/Comments: "${recipeText.slice(0, 4000)}"
Diet preferences: ${dietContext}

CRITICAL RULES for diet version:
- Total calories MUST be at least 20% lower than original
- If "Low Calorie" is selected: reduce calories by 30-40% minimum
- If "High Protein" is selected: increase protein but STILL reduce total calories
- If "Keto" is selected: remove sugar/carbs drastically
- Use lower-calorie substitutes (e.g. almond flour has more calories than wheat - avoid unless keto)
- Reduce amounts of high-calorie ingredients (butter, oil, sugar)
- Do NOT add ingredients that increase total calories

UNIT RULES (CRITICAL for accurate calorie calculation):
- ALL ingredient amounts MUST be numeric values in g or ml — never use vague words
- Convert ALL units to g or ml: "2 tbsp soy sauce" → amount: 30, unit: "ml"
- For countable items without a standard weight, ESTIMATE based on context:
  * "개" (piece): egg=50g, onion=150g, garlic clove=5g, potato=150g, carrot=100g
  * "대" (stalk): green onion=30g, carrot=100g, cucumber=150g
  * "봉지/팩" (pack): use product weight from context, or default 200g
  * "slice" of bread=30g, cheese=20g, meat=80g
- Minimum amount is 1 — never return 0 for any ingredient
- If amount is truly unknown, use a reasonable default (e.g. 100g for main ingredients, 5g for seasonings)

SERVING RULES:
- ALWAYS normalize all ingredient amounts to exactly 1 serving (per person)
- Divide all amounts by the total number of servings in the original recipe
- Set "servings": 1 in both original and diet JSON

TASK:
1. Extract ingredients with exact amounts (g or ml) from the description/comments, normalized to 1 serving
2. Create a diet-optimized version with ingredient substitutions
3. Extract cooking steps

Return ONLY valid JSON:
{
  "original": {
    "title": "string",
    "servings": 1,
    "cookTime": 30,
    "ingredients": [{"name": "string", "amount": 100, "unit": "g"}],
    "steps": ["step1", "step2"]
  },
  "diet": {
    "title": "string",
    "servings": 1,
    "cookTime": 30,
    "ingredients": [{"name": "string", "amount": 100, "unit": "g"}],
    "steps": ["step1", "step2"],
    "substitutions": [
      {
        "original": {"name": "string", "amount": 100, "unit": "g"},
        "replacement": {"name": "string", "amount": 80, "unit": "g"},
        "reason": "why this helps"
      }
    ]
  }
}`;

  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3
      })
    });

    const gptData = await gptRes.json();
    if (gptData.error) return res.status(500).json({ error: gptData.error.message });

    const result = JSON.parse(gptData.choices[0].message.content);

    const [origNutrition, dietNutrition] = await Promise.all([
      getNutritionFromUSDA(result.original.ingredients, fetch),
      getNutritionFromUSDA(result.diet.ingredients, fetch)
    ]);

    result.original.nutrition = origNutrition;
    result.diet.nutrition = dietNutrition;

    res.json({ success: true, ...result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요' });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
  });
}

module.exports = app;
