'use strict';
// Подсказки команд Minecraft: предметы с русскими названиями, режимы, погода и т.д.
export const MC_ITEMS = [
  ['apple', 'Яблоко'], ['bread', 'Хлеб'], ['stone', 'Камень'], ['diamond', 'Алмаз'], ['iron_ingot', 'Железный слиток'], ['gold_ingot', 'Золотой слиток'],
  ['netherite_ingot', 'Незеритовый слиток'], ['emerald', 'Изумруд'], ['coal', 'Уголь'], ['redstone', 'Красная пыль'], ['lapis_lazuli', 'Лазурит'], ['copper_ingot', 'Медный слиток'],
  ['oak_log', 'Дубовое бревно'], ['oak_planks', 'Дубовые доски'], ['cobblestone', 'Булыжник'], ['dirt', 'Земля'], ['grass_block', 'Блок травы'], ['sand', 'Песок'], ['gravel', 'Гравий'],
  ['glass', 'Стекло'], ['torch', 'Факел'], ['crafting_table', 'Верстак'], ['furnace', 'Печь'], ['chest', 'Сундук'], ['ender_chest', 'Сундук Края'], ['bed', 'Кровать'],
  ['diamond_sword', 'Алмазный меч'], ['diamond_pickaxe', 'Алмазная кирка'], ['diamond_axe', 'Алмазный топор'], ['diamond_shovel', 'Алмазная лопата'], ['diamond_helmet', 'Алмазный шлем'],
  ['diamond_chestplate', 'Алмазный нагрудник'], ['diamond_leggings', 'Алмазные поножи'], ['diamond_boots', 'Алмазные ботинки'],
  ['netherite_sword', 'Незеритовый меч'], ['netherite_pickaxe', 'Незеритовая кирка'], ['netherite_chestplate', 'Незеритовый нагрудник'],
  ['iron_sword', 'Железный меч'], ['iron_pickaxe', 'Железная кирка'], ['iron_axe', 'Железный топор'], ['iron_helmet', 'Железный шлем'], ['iron_chestplate', 'Железный нагрудник'],
  ['stone_sword', 'Каменный меч'], ['stone_pickaxe', 'Каменная кирка'], ['wooden_sword', 'Деревянный меч'], ['wooden_pickaxe', 'Деревянная кирка'],
  ['bow', 'Лук'], ['crossbow', 'Арбалет'], ['arrow', 'Стрела'], ['shield', 'Щит'], ['trident', 'Трезубец'], ['elytra', 'Элитры'], ['totem_of_undying', 'Тотем бессмертия'],
  ['golden_apple', 'Золотое яблоко'], ['enchanted_golden_apple', 'Зачарованное золотое яблоко'], ['cooked_beef', 'Жареная говядина'], ['cooked_porkchop', 'Жареная свинина'],
  ['cooked_chicken', 'Жареная курица'], ['cake', 'Торт'], ['cookie', 'Печенье'], ['carrot', 'Морковь'], ['potato', 'Картофель'], ['wheat', 'Пшеница'], ['water_bucket', 'Ведро воды'], ['lava_bucket', 'Ведро лавы'],
  ['bucket', 'Ведро'], ['ender_pearl', 'Жемчужина Края'], ['ender_eye', 'Око Края'], ['blaze_rod', 'Стержень ифрита'], ['experience_bottle', 'Пузырёк опыта'], ['enchanted_book', 'Зачарованная книга'],
  ['book', 'Книга'], ['name_tag', 'Бирка'], ['saddle', 'Седло'], ['lead', 'Поводок'], ['fishing_rod', 'Удочка'], ['flint_and_steel', 'Огниво'], ['compass', 'Компас'], ['clock', 'Часы'], ['map', 'Карта'],
  ['tnt', 'Динамит'], ['obsidian', 'Обсидиан'], ['netherrack', 'Незерак'], ['glowstone', 'Светокамень'], ['beacon', 'Маяк'], ['shulker_box', 'Шалкеровый ящик'], ['barrel', 'Бочка'],
  ['anvil', 'Наковальня'], ['enchanting_table', 'Стол зачарований'], ['brewing_stand', 'Варочная стойка'], ['hopper', 'Воронка'], ['piston', 'Поршень'], ['redstone_torch', 'Редстоуновый факел'],
  ['minecart', 'Вагонетка'], ['rail', 'Рельсы'], ['powered_rail', 'Заряженные рельсы'], ['oak_boat', 'Дубовая лодка'], ['command_block', 'Командный блок'], ['barrier', 'Барьер'],
  ['spawner', 'Спавнер'], ['dragon_egg', 'Яйцо дракона'], ['nether_star', 'Звезда Нижнего мира'], ['netherite_scrap', 'Незеритовый лом'], ['amethyst_shard', 'Осколок аметиста'],
  ['spyglass', 'Подзорная труба'], ['firework_rocket', 'Фейерверк'], ['ender_dragon_spawn_egg', 'Яйцо призыва дракона'],
];
export const MC_SELECTORS = ['@a', '@p', '@s', '@r', '@e'];
export const MC_ARG = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  weather: ['clear', 'rain', 'thunder'],
  'time set': ['day', 'noon', 'night', 'midnight', '0', '1000', '6000', '13000', '18000'],
  gamerule: ['keepInventory', 'doDaylightCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick', 'pvp', 'announceAdvancements'],
  effect: ['give', 'clear'],
  'whitelist': ['add', 'remove', 'list', 'on', 'off'],
};
