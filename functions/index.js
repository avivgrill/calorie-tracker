const functions = require('firebase-functions');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { GoogleAuth } = require('google-auth-library');
const fetch = require('node-fetch');

const VERTEX_REGION = 'global';
const VERTEX_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-1.5-flash-002'
];
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const VERTEX_API_HOST = 'https://aiplatform.googleapis.com';
const vertexAuth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

/**
 * Cloud Function to estimate calories using Gemini API.
 * This keeps the API key secure on the backend.
 */
exports.estimateCalories = onCall(
  {},
  async (request) => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'User must be authenticated to use this function'
      );
    }

    const { userText, userWeightLbs, userHeightInches, userAge, userGender } = request.data;

    // Validate input
    if (!userText || typeof userText !== 'string') {
      throw new HttpsError(
        'invalid-argument',
        'userText is required and must be a string'
      );
    }

    if (!userWeightLbs || typeof userWeightLbs !== 'number') {
      throw new HttpsError(
        'invalid-argument',
        'userWeightLbs is required and must be a number'
      );
    }

    if (!PROJECT_ID) {
      console.error('Google Cloud project ID missing');
      throw new HttpsError(
        'failed-precondition',
        'Cloud project configuration missing'
      );
    }

  // Build the expert prompt
  const prompt = buildExpertPrompt(userText, userWeightLbs, userHeightInches, userAge, userGender);

  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: {
      parts: [{
        text: "Act as a nutrition estimator that answers like a direct AI response to a user question. " +
              "Use typical serving sizes and common preparations. If unspecified, assume plain/unsweetened " +
              "versions with minimal add-ins. Apply quantity multipliers when the user specifies counts or sizes. " +
              "Return valid JSON only - no conversational text, no explanations."
      }]
    },
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  try {
    const tokenClient = await vertexAuth.getClient();
    const accessToken = await tokenClient.getAccessToken();
    if (!accessToken || !accessToken.token) {
      throw new HttpsError('failed-precondition', 'Unable to obtain Vertex access token.');
    }

    let sawNotFound = false;
    let sawRateLimited = false;
    let sawUnavailable = false;
    let lastProviderError = null;

    for (const modelName of VERTEX_MODELS) {
      const url = `${VERTEX_API_HOST}/v1/projects/${PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${modelName}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken.token}`
        }
      });

      const result = await response.json();

      if (response.ok && !result.error) {
        // Extract the raw text response
        const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!rawText) {
          throw new HttpsError('internal', 'Empty response from Vertex Gemini API');
        }
        return { success: true, rawText };
      }

      const providerError = result?.error || {};
      const providerStatus = providerError.status || `HTTP_${response.status}`;
      const providerCode = providerError.code || response.status;
      const providerMessage = providerError.message || 'Unknown Gemini error';

      console.error('Vertex Gemini API error:', {
        modelName,
        httpStatus: response.status,
        providerStatus,
        providerCode,
        providerMessage
      });

      if (response.status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
        sawRateLimited = true;
        lastProviderError = { providerStatus, providerCode, providerMessage };
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new HttpsError(
          'failed-precondition',
          'AI request was rejected by Google due to project configuration, permissions, or billing.',
          {
            reason: 'auth_or_billing_or_permissions',
            nextStep: 'Verify Gemini API access, project permissions, and active billing for this Firebase project.',
            providerStatus,
            providerCode
          }
        );
      }

      if (response.status === 404 || providerStatus === 'NOT_FOUND') {
        sawNotFound = true;
        lastProviderError = { providerStatus, providerCode, providerMessage };
        continue;
      }

      if (response.status >= 500) {
        sawUnavailable = true;
        lastProviderError = { providerStatus, providerCode, providerMessage };
        continue;
      }

      lastProviderError = { providerStatus, providerCode, providerMessage };
      break;
    }

    if (sawRateLimited) {
      throw new HttpsError(
        'resource-exhausted',
        'AI service is temporarily rate-limited or out of quota for this project.',
        {
          reason: 'rate_limit_or_quota',
          nextStep: 'Wait 1-2 minutes, then retry. If it persists, check Vertex AI quotas and billing in Google Cloud.'
        }
      );
    }

    if (sawUnavailable) {
      throw new HttpsError(
        'unavailable',
        'AI provider is temporarily unavailable.',
        {
          reason: 'provider_unavailable',
          nextStep: 'Retry in a minute.'
        }
      );
    }

    if (sawNotFound) {
      throw new HttpsError(
        'failed-precondition',
        'No enabled Vertex Gemini model is currently accessible for this project.',
        {
          reason: 'vertex_model_not_accessible',
          nextStep: 'Enable Vertex Gemini models in this project or use a model your project has access to.',
          providerStatus: lastProviderError?.providerStatus,
          providerCode: lastProviderError?.providerCode
        }
      );
    }

    throw new HttpsError(
      'internal',
      'AI request failed unexpectedly.',
      {
        reason: 'unexpected_provider_error',
        providerStatus: lastProviderError?.providerStatus,
        providerCode: lastProviderError?.providerCode,
        providerMessage: lastProviderError?.providerMessage
      }
    );
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error('Error calling Vertex Gemini API:', error);
    throw new HttpsError(
      'unavailable',
      'Could not reach AI provider.',
      {
        reason: 'network_or_transport_error',
        nextStep: 'Check network connectivity and retry.'
      }
    );
  }
});

/**
 * Build a simple, direct prompt for accurate calorie/exercise estimation
 */
function buildExpertPrompt(userText, userWeightLbs, userHeightInches, userAge, userGender) {
  const userWeightKg = (userWeightLbs * 0.453592).toFixed(1);
  const userInfo = `User weight: ${userWeightLbs} lbs (${userWeightKg} kg)${userHeightInches ? `, Height: ${userHeightInches} inches` : ''}${userAge ? `, Age: ${userAge} years` : ''}${userGender ? `, Gender: ${userGender}` : ''}`;

  return `User input: "${userText}"
${userInfo}

Analyze this and respond with ONLY this JSON format (no markdown, no backticks):
{
  "type": "meal" or "exercise",
  "name": "clear description",
  "cals": number,
  "pro": protein_grams,
  "fib": fiber_grams,
  "sug": sugar_grams,
  "carb": carbohydrate_grams,
  "fat": fat_grams,
  "confidence": "low" or "medium" or "high"
}

For exercises, estimate calories burned accurately based on exercise type, duration, intensity, and user characteristics. Use your training data on exercise physiology and calorie burn rates. Set pro/fib/sug/carb/fat to 0.

For meals, follow this logic:
1. Interpret the request as a direct nutrition question (e.g., "How many calories and macros are in...").
2. Use typical serving sizes and common preparations. If unspecified, assume plain/unsweetened versions with minimal add-ins.
3. Pay careful attention to quantities and multipliers. If the user says "2 coffee" or "3 eggs", multiply the calories and macros by that number.
4. Be accurate and realistic—do not overestimate. Use common reference servings for vague items.`;
}
