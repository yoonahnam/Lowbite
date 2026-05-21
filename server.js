const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const OPENAI_API_KEY = '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';
const YOUTUBE_API_KEY = 'AIzaSyBUFfl1XPnpZ3W7Xk5lc9wscvinlrfK45Q';
const USDA_API_KEY = 'yceZ6scW7uamMM8kK6cpQ6pjEq1RuUOeSoFZ4Ulq';

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

// 더보기란 + 고정 댓글에서 레시피 텍스트 추출
async function getYoutubeRecipeText(videoId, fetch) {
  let text = '';

  try {
    // 1. 더보기란 (description) 가져오기
    const videoRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`
    );
    const videoData = await videoRes.json();
    const description = videoData.items?.[0]?.snippet?.description || '';
    text += description;

    // 2. 고정 댓글 가져오기
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

// USDA API로 재료별 영양소 가져오기
async function getNutritionFromUSDA(ingredients, fetch) {
  let totalNutrition = {
    calories: 0, carbs: 0, sugar: 0,
    protein: 0, fat: 0, sodium: 0, cholesterol: 0
  };

  for (const ing of ingredients) {
    try {
      const res = await fetch(
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(ing.name)}&pageSize=1&api_key=${USDA_API_KEY}`
      );
      const data = await res.json();
      const food = data.foods?.[0];
      if (!food) continue;

      const nutrients = food.foodNutrients || [];
      const get = (name) => nutrients.find(n => n.nutrientName?.includes(name))?.value || 0;

      // 100g 기준 → 실제 g수로 환산
      const ratio = (ing.amount || 100) / 100;
      totalNutrition.calories   += (get('Energy') * ratio);
      totalNutrition.carbs      += (get('Carbohydrate') * ratio);
      totalNutrition.sugar      += (get('Sugars') * ratio);
      totalNutrition.protein    += (get('Protein') * ratio);
      totalNutrition.fat        += (get('Total lipid') * ratio);
      totalNutrition.sodium     += (get('Sodium') * ratio / 1000); // mg → g
      totalNutrition.cholesterol+= (get('Cholesterol') * ratio);

    } catch (e) {
      console.log(`USDA 오류 (${ing.name}):`, e.message);
    }
  }

  // 반올림
  Object.keys(totalNutrition).forEach(k => {
    totalNutrition[k] = Math.round(totalNutrition[k]);
  });
  // sodium 다시 mg로
  totalNutrition.sodium = Math.round(totalNutrition.sodium * 1000);

  return totalNutrition;
}

app.post('/api/extract', async (req, res) => {
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

    // 제목 가져오기
    try {
      const meta = await fetch(`https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${videoId}&format=json`);
      const metaData = await meta.json();
      videoTitle = metaData.title || url;
    } catch (e) {}
  }

  const dietContext = dietTypes && dietTypes.length > 0
    ? dietTypes.join(', ') : 'General healthy diet';

  // GPT로 재료 파싱 + 다이어트 대체재료 생성
  const prompt = `You are a professional nutritionist and chef AI.

Video title: "${videoTitle}"
Description/Comments: "${recipeText.slice(0, 4000)}"
Diet preferences: ${dietContext}

TASK:
1. Extract ingredients with exact amounts (g, ml, etc) from the description/comments
2. Create a diet-optimized version with STRICTLY LOWER calories
3. Extract cooking steps

CRITICAL RULES for diet version:
- Total calories MUST be at least 20% lower than original
- If "Low Calorie" is selected: reduce calories by 30-40% minimum
- If "High Protein" is selected: increase protein but STILL reduce total calories
- If "Keto" is selected: remove sugar/carbs drastically
- Use lower-calorie substitutes (e.g. almond flour has more calories than wheat - avoid unless keto)
- Reduce amounts of high-calorie ingredients (butter, oil, sugar)
- Do NOT add ingredients that increase total calories
- Calculate realistic nutrition based on actual ingredient amounts

TASK:
1. Extract ingredients with exact amounts (g, ml, etc) from the description/comments
2. Create a diet-optimized version with ingredient substitutions
3. Extract cooking steps

Return ONLY valid JSON:
{
  "original": {
    "title": "string",
    "servings": 2,
    "cookTime": 30,
    "ingredients": [{"name": "string", "amount": 100, "unit": "g"}],
    "steps": ["step1", "step2"]
  },
  "diet": {
    "title": "string",
    "servings": 2,
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

    // USDA로 실제 영양소 계산
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

app.listen(3000, () => {
  console.log('서버 실행 중: http://localhost:3000');
});