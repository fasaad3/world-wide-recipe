import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = join(root, 'data', 'unitools-recipes-v1.json');
const datasetUrl = 'https://theunitools.com/data/unitools-recipes-v1.json';
const port = Number(process.env.PORT || 5500);
const gzipAsync = promisify(gzip);
let compressedBoundaries;
const mimeTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
});

let catalogPromise;
let catalogState = 'starting';

function json(response, status, body) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
}

function datasetToCatalog(dataset) {
  const recipes = Array.isArray(dataset) ? dataset : dataset?.recipes;
  if (!Array.isArray(recipes)) throw new Error('В файле базы не найден массив recipes.');
  const byCountry = new Map();
  const bySlug = new Map();
  for (const recipe of recipes) {
    if (!recipe?.slug || !recipe?.country) continue;
    const country = String(recipe.country).toUpperCase();
    const list = byCountry.get(country) || [];
    list.push(recipe);
    byCountry.set(country, list);
    bySlug.set(recipe.slug, recipe);
  }
  return {
    attribution: dataset?.attribution || 'UniTools — theunitools.com',
    landingPage: dataset?.landingPage || 'https://theunitools.com/ru/data',
    license: dataset?.license || 'CC BY-SA 4.0',
    recipes,
    byCountry,
    bySlug
  };
}

async function readLocalCatalog() {
  return datasetToCatalog(JSON.parse(await readFile(dataFile, 'utf8')));
}

async function downloadCatalog() {
  catalogState = 'downloading';
  const response = await fetch(datasetUrl, {
    headers: { 'User-Agent': 'WorldWideRecipeLocal/1.0 (+school project)' }
  });
  if (!response.ok) throw new Error(`Не удалось скачать базу UniTools: HTTP ${response.status}.`);
  const raw = await response.text();
  const catalog = datasetToCatalog(JSON.parse(raw));
  await mkdir(dirname(dataFile), { recursive: true });
  try {
    await writeFile(dataFile, raw, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return catalog;
}

async function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = readLocalCatalog().catch(async error => {
      if (error?.code !== 'ENOENT') throw error;
      return downloadCatalog();
    }).then(catalog => {
      catalogState = 'ready';
      return catalog;
    }).catch(error => {
      catalogState = 'error';
      catalogPromise = undefined;
      throw error;
    });
  }
  return catalogPromise;
}

function preview(recipe) {
  return {
    slug: recipe.slug,
    country: recipe.country,
    name: recipe.name?.ru || recipe.name?.en || recipe.slug,
    summary: recipe.summary?.ru || recipe.summary?.en || '',
    category: recipe.category || 'main',
    difficulty: recipe.difficulty || 'medium',
    servings: recipe.baseServings || null,
    prepMinutes: recipe.prepMinutes || 0,
    cookMinutes: recipe.cookMinutes || 0
  };
}

function publicRecipe(recipe) {
  return {
    ...preview(recipe),
    nativeName: recipe.nativeName || null,
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    steps: Array.isArray(recipe.steps) ? recipe.steps : [],
    nutritionPerServing: recipe.nutritionPerServing || null
  };
}

function safeStaticPath(pathname) {
  const path = pathname === '/' ? 'html.html' : pathname.slice(1);
  const file = normalize(join(root, path));
  return relative(root, file).startsWith('..') ? null : file;
}

function acceptsGzip(header = '') {
  const encodings = new Map(header.split(',').map(entry => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    return [name.trim(), quality === undefined ? 1 : Number(quality.slice(2))];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

async function sendStatic(request, response, pathname) {
  const file = safeStaticPath(pathname);
  if (!file) return json(response, 403, { error: 'Доступ запрещён.' });
  try {
    const info = await stat(file);
    if (!info.isFile()) return json(response, 404, { error: 'Файл не найден.' });
    const headers = {
      'Content-Length': info.size,
      'Content-Type': mimeTypes[extname(file).toLowerCase()] || 'application/octet-stream'
    };
    if (pathname === '/data/world-boundaries.geojson') {
      const etag = `W/"${info.size}-${info.mtimeMs}"`;
      headers.ETag = etag;
      headers.Vary = 'Accept-Encoding';
      headers['Cache-Control'] = 'no-cache';
      const tags = request.headers['if-none-match']?.split(',').map(tag => tag.trim());
      if (tags?.includes(etag) || tags?.includes('*')) {
        delete headers['Content-Length'];
        response.writeHead(304, headers).end();
        return;
      }
      if (acceptsGzip(request.headers['accept-encoding'])) {
        if (compressedBoundaries?.etag !== etag) {
          const body = readFile(file).then(bytes => gzipAsync(bytes));
          compressedBoundaries = { etag, body };
          body.catch(() => {
            if (compressedBoundaries?.body === body) compressedBoundaries = undefined;
          });
        }
        const body = await compressedBoundaries.body;
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = body.length;
        response.writeHead(200, headers).end(body);
        return;
      }
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  } catch {
    json(response, 404, { error: 'Файл не найден.' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method !== 'GET') return json(response, 405, { error: 'Разрешены только GET-запросы.' });
  if (url.pathname === '/api/status') {
    try {
      const catalog = await getCatalog();
      return json(response, 200, { status: catalogState, recipes: catalog.recipes.length, source: catalog.attribution, license: catalog.license });
    } catch (error) {
      return json(response, 503, { status: catalogState, error: error.message });
    }
  }
  if (url.pathname === '/api/recipes') {
    const country = (url.searchParams.get('country') || '').trim().toUpperCase();
    const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('ru');
    const requestedLimit = Number(url.searchParams.get('limit') || 3);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 24) : 3;
    if (!/^[A-Z]{2}$/.test(country)) return json(response, 400, { error: 'Передайте двухбуквенный код страны: ?country=IT' });
    try {
      const catalog = await getCatalog();
      const recipes = (catalog.byCountry.get(country) || []).filter(recipe => {
        if (!query) return true;
        const name = recipe.name?.ru || recipe.name?.en || '';
        const summary = recipe.summary?.ru || recipe.summary?.en || '';
        return `${name} ${summary}`.toLocaleLowerCase('ru').includes(query);
      });
      return json(response, 200, {
        country,
        count: recipes.length,
        recipes: recipes.slice(0, limit).map(preview),
        source: catalog.attribution,
        landingPage: catalog.landingPage,
        license: catalog.license
      });
    } catch (error) {
      return json(response, 503, { error: error.message });
    }
  }
  if (url.pathname.startsWith('/api/recipes/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/recipes/'.length));
    try {
      const catalog = await getCatalog();
      const recipe = catalog.bySlug.get(slug);
      if (!recipe) return json(response, 404, { error: 'Рецепт не найден.' });
      return json(response, 200, {
        recipe: publicRecipe(recipe),
        source: catalog.attribution,
        landingPage: catalog.landingPage,
        license: catalog.license
      });
    } catch (error) {
      return json(response, 503, { error: error.message });
    }
  }
  return sendStatic(request, response, url.pathname);
});

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`World Wide Recipe: http://127.0.0.1:${port}`);
  console.log('Локальная база UniTools будет скачана один раз и сохранена в data/unitools-recipes-v1.json.');
  void getCatalog().catch(error => console.error(`База пока недоступна: ${error.message}`));
});
