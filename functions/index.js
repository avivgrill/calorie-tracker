const functions = require('firebase-functions');
const fetch = require('node-fetch');

/**
 * Cloud Function to estimate calories using Gemini API.
 * This keeps the API key secure on the backend.
 */
exports.estimateCalories = functions.https.onCall(async (data, context) => {
  // Require authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated to use this function'
    );
  }

  const { userText, userWeightLbs } = data;

  // Validate input
  if (!userText || typeof userText !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'userText is required and must be a string'
    );
  }

  if (!userWeightLbs || typeof userWeightLbs !== 'number') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'userWeightLbs is required and must be a number'
    );
  }

  // Get API key from environment config
  const GEMINI_KEY = functions.config().gemini?.key;
  
  if (!GEMINI_KEY) {
    console.error('Gemini API key not configured');
    throw new functions.https.HttpsError(
      'failed-precondition',
      'API key not configured'
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

  // Build the expert prompt
  const prompt = buildExpertPrompt(userText, userWeightLbs);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();
    
    if (result.error) {
      console.error('Gemini API error:', result.error);
      throw new functions.https.HttpsError('internal', result.error.message);
    }

    // Extract the raw text response
    const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!rawText) {
      throw new functions.https.HttpsError('internal', 'Empty response from Gemini API');
    }

    // Return the raw text - let client handle parsing
    return { success: true, rawText };
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw new functions.https.HttpsError(
      'internal',
      error.message || 'Failed to process request'
    );
  }
});

/**
 * Build the expert-level prompt for accurate calorie/exercise estimation
 */
function buildExpertPrompt(userText, userWeightLbs) {
  return `You are an expert nutritionist and exercise physiologist with comprehensive knowledge of:
- USDA FoodData Central database
- Restaurant nutrition data (Chipotle, McDonald's, Starbucks, etc.)
- Packaged food nutrition labels
- Exercise MET values and calorie burn calculations

Your task: Analyze the user's input and provide accurate calorie estimates.

USER INPUT: "${userText}"
USER WEIGHT: ${userWeightLbs} lbs (${(userWeightLbs * 0.453592).toFixed(1)} kg)

INSTRUCTIONS:

1. DETERMINE TYPE: Is this food/drink (meal) or physical activity (exercise)?

2. FOR FOOD/MEALS:
   - Identify EACH distinct food item mentioned
   - For each item, determine:
     * Specific food type (e.g., "white rice, cooked" not just "rice")
     * Portion size (infer from context, or use standard serving if unspecified)
     * Brand/restaurant if mentioned (use their actual nutrition data)
     * Preparation method if relevant (fried vs grilled changes calories significantly)
   - Calculate calories and macros for each item
   - Sum totals

   PORTION SIZE GUIDELINES:
   - "a bowl of rice" = ~1.5 cups cooked = ~300 cal
   - "a slice of pizza" = 1/8 of 14" pizza = ~250-350 cal depending on toppings
   - "a bite" = approximately 1/10 to 1/15 of the full item
   - "a handful" of nuts = ~1 oz = ~160-180 cal
   - "some" without context = assume 1 standard serving
   - Restaurant portions are typically 1.5-2x standard serving sizes

   COMMON REFERENCE VALUES:
   - Chipotle burrito bowl with rice, beans, meat, cheese, guac = ~900-1100 cal
   - McDonald's Big Mac = 563 cal
   - Starbucks grande latte = 190 cal (whole milk)
   - Slice of cheese pizza (14") = 285 cal
   - Grilled chicken breast (6 oz) = 280 cal
   - Cup of cooked white rice = 205 cal
   - Medium banana = 105 cal
   - Tablespoon olive oil = 119 cal

3. FOR EXERCISE:
   - Identify the activity type
   - Determine duration (infer reasonable duration if not specified)
   - Determine intensity (low/moderate/high)
   - Calculate calories burned using: Calories = MET × weight(kg) × time(hours)
   
   MET VALUES:
   - Walking (3 mph): 3.5 | Walking brisk (4 mph): 4.3
   - Running (5 mph): 8.3 | Running (6 mph): 9.8 | Running (8 mph): 11.8
   - Cycling (moderate): 7.5 | Cycling (vigorous): 10
   - Swimming (moderate): 6 | Swimming (vigorous): 9.5
   - Weight training: 5-6 | HIIT: 8-10
   - Yoga: 3 | Pilates: 3.5
   
   If duration not specified, assume: walking=30min, running=30min, gym=45min

4. GENERATE A CLEAN SUMMARY NAME:
   - Convert informal language to clear, specific descriptions
   - Include quantities and portions
   - Examples:
     * "had some pizza at dominos" → "2 slices Domino's pepperoni pizza"
     * "ate half my friend's sandwich" → "1/2 turkey sandwich"
     * "went for a run" → "30 min run (moderate pace)"
     * "3 bites of cake" → "3 bites chocolate cake (~1/5 slice)"

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{
  "type": "meal" or "exercise",
  "name": "clean, detailed summary with quantities",
  "items": [
    {
      "name": "specific item name",
      "quantity": "amount with unit",
      "cals": number,
      "pro": number,
      "fib": number,
      "sug": number,
      "fat": number,
      "notes": "brief reasoning"
    }
  ],
  "cals": total_calories_number,
  "pro": total_protein_grams,
  "fib": total_fiber_grams,
  "sug": total_sugar_grams,
  "fat": total_fat_grams,
  "confidence": "low" or "medium" or "high"
}

For exercise, set pro/fib/sug/fat to 0.

IMPORTANT: 
- Be accurate, not conservative. Use real nutritional data.
- For branded/restaurant items, use their actual published nutrition info.
- If truly uncertain, provide your best estimate with "low" confidence.
- ALWAYS return valid JSON with numeric values for cals/pro/fib/sug/fat.`;
}
