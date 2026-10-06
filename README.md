# Zbiornik Inbox

Aplikacja na macOS do podglądu wiadomości i powiadomień z zbiornik.com.

## Uruchomienie w trybie deweloperskim

    npm install
    npm start

## Budowanie .dmg

    npm run dist        # universal (Apple Silicon + Intel)
    npm run dist:arm    # tylko Apple Silicon, szybciej

Gotowy plik pojawi się w katalogu `dist/`.

Aplikacja jest podpisana tylko lokalnie (ad-hoc), więc przy pierwszym uruchomieniu
macOS ją zablokuje. Otwórz ją przez prawy klik → Otwórz albo:

    xattr -dr com.apple.quarantine "/Applications/Zbiornik Inbox.app"

## Typy powiadomień

Przy `npm start` w terminalu wypisuje się każdy nowy typ powiadomienia.
Nazwy dopisujesz w `renderer/renderer.js` w obiekcie `TYPE_LABELS`.
# zbiorkom
