import type { RequestHandler } from '@sveltejs/kit';
import { PASSWORD } from '$env/static/private';
import { supabase } from '$lib/clients/supabaseClient';
import { cleanHtml } from '$lib/helpers/cleanHtml';
import { removeUnwantedSpaces } from '$lib/helpers/removeUnwantedSpaces';
import { fixLinkPunctuation } from '$lib/helpers/fixLinkPunctuation';
import { insertFeedbackElement } from '$lib/helpers/insertFeedbackElement';
import { logAccess } from '$lib/helpers/logAccess';
import { translateText } from '$lib/clients/googleClient-v3';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { articleId, srcLanguage = 'en', targetLanguage, htmlContent, password, lastUpdated, accessIds, allowTranslationReview, model } = await request.json();
    const referer = request.headers.get('referer');

    // List of allowed referers
    const allowedReferers = ['platformsh.site', 'thenewhumanitarian.org', 'thenewhumanitarian.org.ddev.site'];

    const isAllowedReferer = allowedReferers.some(allowedReferer => referer && referer.includes(allowedReferer));

    if (!isAllowedReferer && password !== PASSWORD) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const cleanedHtmlContent = cleanHtml(htmlContent);

    console.log(`Received request to translate articleId: ${articleId} from ${srcLanguage} to ${targetLanguage} using model ${model}`);

    // Check if translation exists in Supabase by matching the article ID, target language, and last updated time
    const { data, error } = await supabase
      .from('translations')
      .select('*')
      .eq('article_id', articleId)
      .eq('src_language', srcLanguage)
      .eq('target_language', targetLanguage)
      .eq('last_updated', lastUpdated)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116: single row not found
      console.error(`Supabase error: ${error.message}`);
      console.error(`Supabase error details: ${JSON.stringify(error, null, 2)}`);
      throw new Error(`Supabase error: ${error.message}`);
    }

    let cleanedTranslation;
    let source;
    let translationId;
    let accessId;

    if (data) {
      console.log('Translation found in Supabase');
      accessId = await logAccess('supabase', articleId, srcLanguage, targetLanguage);
      cleanedTranslation = data.translation;
      source = 'supabase';
      translationId = data.id;
    } else {
      console.log('Translation not found in Supabase, using Google Translate');

      const result = await translateText(cleanedHtmlContent, srcLanguage, targetLanguage, model);

      cleanedTranslation = cleanHtml(result);
      cleanedTranslation = removeUnwantedSpaces(cleanedTranslation);
      cleanedTranslation = fixLinkPunctuation(cleanedTranslation);

      // Store the final translation in the translations table
      const { data: insertedData, error: insertError } = await supabase
        .from('translations')
        .insert([
          { article_id: articleId, src_language: srcLanguage, target_language: targetLanguage, translation: cleanedTranslation, original_string: cleanedHtmlContent, gpt_model: model, last_updated: lastUpdated || new Date().toISOString() }
        ])
        .select('id')
        .single();

      if (insertError) {
        console.error(`Supabase insert error: ${insertError.message}`);
        console.error(`Supabase insert error details: ${JSON.stringify(insertError, null, 2)}`);
        throw new Error(`Supabase insert error: ${insertError.message}`);
      }

      accessId = await logAccess('google_translate', articleId, srcLanguage, targetLanguage);
      source = 'google_translate';
      translationId = insertedData.id;
    }

    // Add the feedback element if allowed and if not already rated
    if (allowTranslationReview) {
      const { data: ratingData, error: ratingError } = await supabase
        .from('translation_ratings')
        .select('*')
        .in('access_id', accessIds)
        .eq('translation_id', translationId);

      if (ratingError) {
        console.error(`Supabase rating check error: ${ratingError.message}`);
        throw new Error(`Supabase rating check error: ${ratingError.message}`);
      }

      const hasRating = ratingData && ratingData.length > 0;

      if (!hasRating) {
        cleanedTranslation = insertFeedbackElement(cleanedTranslation, translationId, accessId, targetLanguage);
      }
    }

    console.log('Translation successful and stored in Supabase');
    // Return the new translation
    return new Response(JSON.stringify({ translation: cleanedTranslation, source, translationId, accessId }), { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (error) {
    console.error(`Error during translation process: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
};

export const OPTIONS: RequestHandler = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
};