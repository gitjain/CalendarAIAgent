const { OpenAI } = require('openai');
const { google } = require('googleapis');

/**
 * Document Processor - Phase 1 Implementation
 * Handles Google Docs URL detection, fetching, and summarization
 */
class DocumentProcessor {
  constructor() {
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  /**
   * Extract Google Docs URLs from text
   */
  extractGoogleDocUrls(text) {
    if (!text) return [];
    
    const urlPattern = /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/g;
    const urls = [];
    let match;
    
    while ((match = urlPattern.exec(text)) !== null) {
      urls.push({
        fullUrl: match[0],
        docId: match[1],
        type: match[0].includes('/document/') ? 'document' : 
              match[0].includes('/spreadsheets/') ? 'spreadsheet' : 'presentation'
      });
    }
    
    return urls;
  }

  /**
   * Fetch Google Docs content via Google Docs API
   */
  async fetchGoogleDoc(docId, tokens) {
    try {
      if (!tokens || !tokens.access_token) {
        throw new Error('Google authentication required. Please sign in to Google Calendar.');
      }

      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials(tokens);

      const docs = google.docs({ version: 'v1', auth: oauth2Client });

      const response = await docs.documents.get({
        documentId: docId
      });

      // Extract text from document structure
      const body = response.data.body;
      let text = '';

      const extractText = (element) => {
        if (element.textRun) {
          text += element.textRun.content;
        }
        if (element.paragraph) {
          const paragraph = element.paragraph;
          if (paragraph.elements) {
            paragraph.elements.forEach(extractText);
          }
        }
        if (element.table) {
          element.table.tableRows.forEach(row => {
            row.tableCells.forEach(cell => {
              if (cell.content) {
                cell.content.forEach(extractText);
              }
            });
          });
        }
      };

      if (body && body.content) {
        body.content.forEach(extractText);
      }

      return {
        title: response.data.title || 'Untitled Document',
        text: text.trim(),
        docId: docId
      };
    } catch (error) {
      console.error('Error fetching Google Doc:', error);
      if (error.code === 404) {
        throw new Error('Document not found or not accessible. Please check the URL and sharing permissions.');
      } else if (error.code === 403) {
        throw new Error('Access denied. Please ensure the document is shared with your Google account.');
      }
      throw new Error(`Failed to fetch Google Doc: ${error.message}`);
    }
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(text) {
    // Rough approximation: ~4 characters per token, or ~0.75 words per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Summarize large documents to fit in context window
   */
  async summarizeDocument(text, maxTokens = 2000) {
    if (!this.openai) {
      throw new Error('OpenAI API key not configured');
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a document summarization assistant. Create a concise summary focusing on key points, decisions, action items, and important details that would be useful for meeting preparation. Keep it under 2000 tokens.'
          },
          {
            role: 'user',
            content: `Summarize this document for meeting preparation, focusing on:\n- Key points and decisions\n- Action items\n- Important questions or topics\n- Timeline or deadlines\n\nDocument content:\n${text}`
          }
        ],
        temperature: 0.5,
        max_tokens: maxTokens
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error summarizing document:', error);
      throw new Error(`Failed to summarize document: ${error.message}`);
    }
  }

  /**
   * Process document URLs and extract content
   */
  async processDocuments(text, tokens) {
    const urls = this.extractGoogleDocUrls(text);
    if (urls.length === 0) {
      return null;
    }

    const documents = [];
    const errors = [];

    for (const urlInfo of urls) {
      try {
        console.log(`📄 Processing Google Doc: ${urlInfo.docId}`);
        const docContent = await this.fetchGoogleDoc(urlInfo.docId, tokens);
        
        // Estimate tokens
        const estimatedTokens = this.estimateTokens(docContent.text);
        const TOKEN_LIMIT = 12000; // Leave room for analysis prompt

        let processedText = docContent.text;
        let wasSummarized = false;

        // If document is too large, summarize it first
        if (estimatedTokens > TOKEN_LIMIT) {
          console.log(`📝 Document too large (${estimatedTokens} tokens), summarizing...`);
          processedText = await this.summarizeDocument(docContent.text, 2000);
          wasSummarized = true;
        }

        documents.push({
          title: docContent.title,
          text: processedText,
          docId: urlInfo.docId,
          url: urlInfo.fullUrl,
          wasSummarized,
          estimatedTokens: estimatedTokens
        });
      } catch (error) {
        console.error(`Error processing document ${urlInfo.docId}:`, error);
        errors.push({
          url: urlInfo.fullUrl,
          error: error.message
        });
      }
    }

    return {
      documents,
      errors,
      hasDocuments: documents.length > 0
    };
  }
}

module.exports = new DocumentProcessor();

