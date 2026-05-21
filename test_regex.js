const testCases = [
    // Le cas qui a échoué chez l'utilisateur
    `Commander Profile
Vaylah
RADJ The_Radiant
#1061`,

    // Cas standard
    `Jon Snow
[GE] Galactic-Empire
#1061`,
    
    // Cas avec crochets dégradés
    `Natalie
(GE) Galactic-Empire
#1062`
];

function cleanName(line) {
    let cleaned = line.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').trim();
    cleaned = cleaned.replace(/^(?:Lv\.?\s*\d+)/i, '').trim();

    const words = cleaned.split(/\s+/);
    if (words.length > 1 && words[0].length <= 2) {
        words.shift();
        cleaned = words.join(' ');
    }

    cleaned = cleaned.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 20).trim();
    return cleaned;
}

function parseOCRText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(line => line !== '');
    
    let guildTag = "[GuildeInconnue]";
    let playerName = "NomInconnu";
    let serverNumber = "";
    
    // 1. Trouver la ligne du serveur (notre ancre la plus stable)
    let serverLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const serverMatch = lines[i].match(/(?:#|No|No\.|N°|S|H|h)\s*([0-9oO]{3,5})/i);
        if (serverMatch) {
            const cleanDigits = serverMatch[1].replace(/[oO]/g, '0');
            serverNumber = ` #${cleanDigits}`;
            serverLineIndex = i;
            break;
        }
    }

    // Heuristique A : Basée sur l'ancre du Serveur (Ordre vertical fixe)
    if (serverLineIndex !== -1) {
        // La ligne juste au-dessus du serveur est l'Alliance/Guilde
        if (serverLineIndex - 1 >= 0) {
            const allianceLine = lines[serverLineIndex - 1];
            // Cherche d'abord s'il y a un tag entre crochets (même dégradés)
            const tagMatch = allianceLine.match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
            if (tagMatch) {
                guildTag = `[${tagMatch[1].trim().toUpperCase()}]`;
            } else {
                // Si pas de crochets, on prend le premier mot (ex: "RADJ The_Radiant" -> "RADJ")
                const firstWord = allianceLine.split(/\s+/)[0].replace(/[^a-zA-Z0-9_-]/g, '');
                if (firstWord.length >= 2 && firstWord.length <= 6) {
                    guildTag = `[${firstWord.toUpperCase()}]`;
                }
            }
        }

        // La ligne encore au-dessus (ou celle d'avant si vide/invalide) est le Pseudo
        for (let i = serverLineIndex - 2; i >= 0; i--) {
            let potentialName = lines[i];
            if (potentialName.toUpperCase().includes('PROFILE') || potentialName.toUpperCase().includes('COMMANDER')) continue;
            
            potentialName = cleanName(potentialName);
            if (potentialName.length >= 3) {
                playerName = potentialName;
                break;
            }
        }
    }

    // Heuristique B (Fallback) : Si l'ancre du serveur a échoué mais qu'on a des crochets
    if (guildTag === "[GuildeInconnue]" || playerName === "NomInconnu") {
        let tagLineIndex = -1;
        
        // Détection du tag de guilde par crochets
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
            if (match) {
                guildTag = `[${match[1].trim().toUpperCase()}]`;
                tagLineIndex = i;
                break;
            }
        }

        if (tagLineIndex !== -1) {
            // Cherche le nom du joueur avant la ligne du tag
            if (playerName === "NomInconnu" && tagLineIndex > 0) {
                for (let i = tagLineIndex - 1; i >= 0; i--) {
                    let line = lines[i];
                    if (line.toUpperCase().includes('PROFILE') || line.toUpperCase().includes('COMMANDER')) continue;
                    line = cleanName(line);
                    if (line.length >= 3) {
                        playerName = line;
                        break;
                    }
                }
            }

            // Cas de secours sur la même ligne
            if (playerName === "NomInconnu") {
                const line = lines[tagLineIndex];
                const matchBefore = line.match(/^([a-zA-Z0-9_-]{3,20})\s*(?:\[|\(|\{|\(|\||l|I|1|\\|\/)/);
                if (matchBefore) {
                    playerName = cleanName(matchBefore[1]);
                } else {
                    const matchAfter = line.match(/(?:\]|\)|\}|\)|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{3,20})/);
                    if (matchAfter) {
                        playerName = cleanName(matchAfter[1]);
                    }
                }
            }
        }
    }

    return {
        guildTag,
        playerName,
        serverNumber
    };
}

// Lancement des tests
testCases.forEach((tc, idx) => {
    const res = parseOCRText(tc);
    console.log(`--- Test ${idx + 1} ---`);
    console.log(`Texte:\n${tc}`);
    console.log(`Résultats du parsing :`);
    console.log(`  Tag de Guilde  : ${res.guildTag}`);
    console.log(`  Nom du Joueur  : ${res.playerName}`);
    console.log(`  N° de Serveur  : ${res.serverNumber || "Non trouvé"}`);
    console.log(`-----------------\n`);
});
