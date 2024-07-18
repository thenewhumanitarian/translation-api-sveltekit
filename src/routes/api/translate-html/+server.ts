import type { RequestHandler } from '@sveltejs/kit';
import { supabase } from '$lib/supabaseClient';
import openai from '$lib/openaiClient';
import { PASSWORD } from '$env/static/private';

function cleanHtml(html: string): string {
  let cleanedHtml = html.replace(/ dir="ltr"/g, '');
  cleanedHtml = cleanedHtml.replace(/<div id="mct-script"><\/div>/g, '');
  return cleanedHtml;
}

function splitHtmlIntoChunks(html: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  const regex = /(<\/?[^>]+>)/g;
  let lastIndex = 0;

  html.replace(regex, (match, tag, index) => {
    const textPart = html.substring(lastIndex, index);
    if (currentChunk.length + textPart.length > chunkSize) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += textPart;
    if (currentChunk.length + match.length > chunkSize) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += match;
    lastIndex = index + match.length;
  });

  const remainingText = html.substring(lastIndex);
  if (remainingText.length > 0) {
    if (currentChunk.length + remainingText.length > chunkSize) {
      chunks.push(currentChunk);
      chunks.push(remainingText);
    } else {
      currentChunk += remainingText;
      chunks.push(currentChunk);
    }
  } else if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function translateLongHtmlContent(htmlContent: string, srcLanguage: string, targetLanguage: string, gptModel: string): Promise<string> {
  const chunkSize = 2000; // Define chunk size
  const chunks = splitHtmlIntoChunks(htmlContent, chunkSize);

  const translatedChunks = await Promise.all(
    chunks.map(async (chunk) => {
      const chatCompletion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: `Translate the following HTML from ${srcLanguage} to ${targetLanguage}, preserving the HTML tags:\n\n${chunk}` }],
        model: gptModel
      });
      return chatCompletion.choices[0].message.content;
    })
  );

  return translatedChunks.join('');
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { articleId, srcLanguage = 'en', targetLanguage, htmlContent, gptModel = 'gpt-3.5-turbo', password, lastUpdated } = await request.json();

    if (password !== PASSWORD) {
      return new Response(JSON.stringify({ error: 'Invalid password' }), { status: 403 });
    }

    const cleanedHtmlContent = cleanHtml(htmlContent);

    console.log(`Received request to translate articleId: ${articleId} from ${srcLanguage} to ${targetLanguage}`);

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

    if (data) {
      console.log('Translation found in Supabase');
      // Return existing translation
      return new Response(JSON.stringify({ translation: data.translation, source: 'supabase', requestData: { articleId, srcLanguage, targetLanguage, htmlContent: cleanedHtmlContent } }), { status: 200 });
    }

    console.log('Translation not found in Supabase, using ChatGPT');

    // If translation doesn't exist, use ChatGPT to translate
    let translatedHtml;
    if (cleanedHtmlContent.length > 2000) {
      translatedHtml = await translateLongHtmlContent(cleanedHtmlContent, srcLanguage, targetLanguage, gptModel);
    } else {
      const chatCompletion = await openai.chat.completions.create({
        messages: [{
          role: 'user',
          content: `Translate the following HTML from ${srcLanguage} to ${targetLanguage}, preserving the HTML tags. Remove empty <p> tags and those which only contain &nbsp;. Don't translate anything inside of the elements with classes: .meta-list, .article__author-location, .image__attr, .author__name, .article__actions or .article__extras.\n\nThe text to translate is::\n\n${cleanedHtmlContent}`
        }],
        model: gptModel
      });
      translatedHtml = chatCompletion.choices[0].message.content;

      // Log token usage
      console.log('Token usage:', chatCompletion.usage);
    }

    // Store the new translation in Supabase
    const { error: insertError } = await supabase
      .from('translations')
      .insert([
        { article_id: articleId, original_string: cleanedHtmlContent, src_language: srcLanguage, target_language: targetLanguage, translation: translatedHtml, gpt_model: gptModel, last_updated: lastUpdated }
      ]);

    if (insertError) {
      console.error(`Supabase insert error: ${insertError.message}`);
      console.error(`Supabase insert error details: ${JSON.stringify(insertError, null, 2)}`);
      throw new Error(`Supabase insert error: ${insertError.message}`);
    }

    console.log('Translation successful and stored in Supabase');
    // Return the new translation
    return new Response(JSON.stringify({ translation: translatedHtml, source: 'chatgpt', requestData: { articleId, srcLanguage, targetLanguage, htmlContent: cleanedHtmlContent } }), { status: 200 });
  } catch (error) {
    console.error(`Error during translation process: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};