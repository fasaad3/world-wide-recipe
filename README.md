# World Wide Recipe: API-версия

## Запуск

```bash
npm start
```

Откройте `http://127.0.0.1:5500`.

При первом запуске сервер скачивает открытый набор UniTools World Recipes (`~2,6 МБ`) в `data/unitools-recipes-v1.json`. После этого карточки рецептов читают только локальный файл через API.

## Локальные методы

- `GET /api/status` — состояние базы.
- `GET /api/recipes?country=IT&limit=3` — рецепты страны по ISO Alpha-2.
- `GET /api/recipes/spaghetti-carbonara` — рецепт по идентификатору.

Исходник рецептов: UniTools World Recipes, CC BY-SA 4.0. Карточки показывают атрибуцию и лицензию. Флаги в этой ветке подгружаются через FlagCDN; для редких кодов карта сохраняет локальный SVG-запасной вариант.
