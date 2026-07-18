import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit for PDF base64 uploading
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Initialize Gemini client on the server
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const ai = geminiApiKey
    ? new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      })
    : null;

  // API Route for PDF extraction using Gemini
  app.post('/api/extract-pdf', async (req, res) => {
    try {
      const { base64 } = req.body;
      if (!base64) {
        return res.status(400).json({ error: 'Données base64 manquantes.' });
      }

      if (!ai) {
        return res.status(500).json({ error: 'Clé API Gemini non configurée sur le serveur.' });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: base64,
            },
          },
          "Extrait les noms des membres et leurs cotisations mensuelles depuis ce document. Renvoie un tableau JSON d'objets. Chaque objet doit avoir un 'name' (chaîne de caractères) et un objet 'payments'. L'objet 'payments' doit avoir comme clés les mois : 'JAN', 'FEV', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILL', 'AOUT', 'SEP', 'OCT', 'NOV', 'DEC'. Les valeurs doivent être des nombres (le montant payé, mettez 0 si rien n'a été payé).",
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                payments: {
                  type: Type.OBJECT,
                  properties: {
                    JAN: { type: Type.NUMBER },
                    FEV: { type: Type.NUMBER },
                    MARS: { type: Type.NUMBER },
                    AVRIL: { type: Type.NUMBER },
                    MAI: { type: Type.NUMBER },
                    JUIN: { type: Type.NUMBER },
                    JUILL: { type: Type.NUMBER },
                    AOUT: { type: Type.NUMBER },
                    SEP: { type: Type.NUMBER },
                    OCT: { type: Type.NUMBER },
                    NOV: { type: Type.NUMBER },
                    DEC: { type: Type.NUMBER },
                  },
                },
              },
              required: ['name', 'payments'],
            },
          },
        },
      });

      const text = response.text;
      return res.json({ text });
    } catch (error: any) {
      console.error('Gemini API Error on Server:', error);
      return res.status(500).json({ error: error.message || 'Une erreur est survenue lors de l\'extraction par Gemini.' });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
