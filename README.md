<div align="center">

[![JavaScript](https://img.shields.io/badge/JavaScript-QuickJS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://frida.re)
[![Sacred](https://img.shields.io/badge/Sacred-Community-8B1A1A?style=for-the-badge&labelColor=1C1410)](https://ancaria.dev)
[![License](https://img.shields.io/badge/License-MIT-4B5563?style=for-the-badge)](LICENSE)

[English](README.EN.md) · [Deutsch](README.DE.md)

</div>

# agent

JavaScript, который ancaria внедряет в Sacred Gold, для тех, кто добавляет в
загрузчик хуки и события.

Frida запускает агента внутри процесса игры. Агент перехватывает функции игры,
сообщает о происходящем событиями, спрашивает моды, разрешить ли действие, и
выполняет их команды. Между игрой и JVM с модами эти сообщения переносит хост
на Rust из [protocol](https://github.com/ancaria-dev/protocol).

Все адреса игры приходят из [mappings](https://github.com/ancaria-dev/mappings)
и относятся к `pureHD.exe` 2.0.2.118. Релиз вшивает адреса и выпускает агента
в сжатом виде как `agent.zip`. Его скачивает лаунчер, так что для игры ничего
ставить вручную не нужно.

## Как начать

Чтобы запустить в игре своего агента:

1. Склонируйте [mappings](https://github.com/ancaria-dev/mappings) рядом с этим
   репозиторием или дайте `tools/addr.py` скачать его.
2. Создайте `.local.settings` с папкой игры:
   `sacred=D:\SteamLibrary\steamapps\common\Sacred Gold`.
3. Запустите `pwsh tools/install.ps1`. Скрипт создаст адреса, упакует агента и
   заменит `<game>/launcher/agent/`.
4. Запустите игру из лаунчера. Если она уже работает, сначала закройте её:
   запущенная игра держит старого агента.

Перед тем как выпустить новый хук, проверьте его командой
`python tools/hooksafe.py` на своей копии игры. В
[docs/RUNNING.md](docs/RUNNING.md) описано, как сузить причину падения до
одного модуля или одной точки.

## Что внутри

| Путь | Что это |
|---|---|
| `src/NN-name.js` | Модули. У них одна общая область видимости, загружаются они по порядку имён файлов. |
| `src/gen/addr.js` | Таблица адресов. Её создаёт `tools/addr.py`, в репозиторий она не попадает. |
| `signatures.json` | Байты инструкций в каждой точке хука, их пишет `tools/hooksafe.py --signatures`. |
| `tools/compact.mjs` | Минификатор: убирает комментарии и отступы и больше ничего не меняет. |
| `tools/pack.mjs` | Собирает `dist/agent/` и `dist/agent.zip`. |
| `tests/` | Проверка сборки игры, тесты минификатора и внедрение через frida-python. |

## agent.zip

Архив плоский, файлы в нём уже сжаты:

```
addr.js       таблица адресов
NN-name.js    все модули
hooks.json    точки хуков по модулям, лаунчер показывает их переключателями
agent.json    {"version":"<версия>","protocol":1}
```

Хост отказывается грузить агента, если его `protocol` не совпадает с номером
самого хоста. Так старый хост не загрузит агента, который говорит другими
сообщениями.

## Сборка

Нужны Python 3.11 и Node 24. Для `tools/hooksafe.py` ещё нужны `pefile` и
`capstone`. Больше ничего ставить не нужно.

```
python tools/addr.py              пишет src/gen/addr.js
python tools/hooksafe.py          отвергает точки, которые испортит трамплин
node tests/buildcheck.js          проверяет предупреждение о сборке на поддельной игре
node --test "tests/*.test.mjs"    тестирует минификатор и чтение хуков
node tools/pack.mjs               пишет dist/agent.zip
```

`addr.py` ищет `mappings.json` в таком порядке: путь из аргумента,
`$AGENT_MAPPINGS`, соседний `../mappings`, затем GitHub на ревизии из
`.mappings-ref`.

## Релизы

Релиз — это кнопка `Release` в Actions: вы вводите версию и, если нужно,
версию mappings, которую вшить. Пустое поле означает последний релиз mappings.
Workflow проверяет реестр, запускает тесты и прикладывает `agent.zip` к
GitHub Release.

[devops](https://github.com/ancaria-dev/devops) запускает этот релиз после
каждого релиза mappings и затем обновляет манифест лаунчера. Подробности — в
корневом
[CONTRIBUTING](https://github.com/ancaria-dev/.github/blob/master/CONTRIBUTING.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
