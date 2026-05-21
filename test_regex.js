const testCases = [
    // Cas 1 : Crochets parfaits, pseudo avant le tag, serveur ok
    `Jon Snow\n[GE] Galactic-Empire\n#1061`,
    
    // Cas 2 : Crochets lus comme des parenthèses, pseudo avant
    `Natalie\n(GE) Galactic-Empire\n#1062`,
    
    // Cas 3 : Crochets lus comme des barres, pseudo avant, serveur avec O au lieu de 0
    `HawkTuah\n|GE| Galactic-Empire\nH1O63`,
    
    // Cas 4 : Tag et pseudo sur la même ligne (crochet dégradé)
    `JonSnow lGEJ Galactic-Empire\nS1064`,
    
    // Cas 5 : Pas de serveur, crochets lus comme l.../
    `Mr Beast\nlYARR/ Pirate-Crew`,
    
    // Cas 6 : Pseudo avec préfixe de niveau (Lv. 50 ou Lv.50)
    `Lv. 60 ald AG21\n[YARR] #1064`
];

function cleanName(line) {
    // Élimine les symboles bizarres de début/fin
    let cleaned = line.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').trim();
    
    // Si la ligne commence par "Lv. X" ou "Lv X", on le retire
    cleaned = cleaned.replace(/^(?:Lv\.?\s*\d+|[a-zA-Z0-9]{1,2}\s*\)?\s*)/i, '').trim();
    
    // Conserver uniquement caractères standards + espaces + tirets
    cleaned = cleaned.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 20).trim();
    return cleaned;
}

function parseOCRText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(line => line !== '');
    
    let guildTag = "[GuildeInconnue]";
    let playerName = "NomInconnu";
    let serverNumber = "";
    let tagLineIndex = -1;
    
    // 1. Détection du tag de guilde (ex: [GE] ou (GE) ou lGE|)
    for (let i = 0; i < lines.length; i++) {
        // Regex robuste tolérant les déformations courantes de crochets
        const match = lines[i].match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
        if (match) {
            const safeInner = match[1].trim().replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 28);
            guildTag = `[${safeInner.toUpperCase()}]`;
            tagLineIndex = i;
            break;
        }
    }
    
    // 2. Détection du pseudo
    if (tagLineIndex > 0) {
        for (let i = tagLineIndex - 1; i >= 0; i--) {
            let line = lines[i];
            line = cleanName(line);
            if (line.length >= 3 && !line.toUpperCase().includes('PROFILE') && !line.toUpperCase().includes('COMMANDER')) {
                playerName = line;
                break;
            }
        }
    }
    
    // Cas de secours : pseudo et tag sur la même ligne
    if (playerName === "NomInconnu" && tagLineIndex !== -1) {
        const line = lines[tagLineIndex];
        // Avant le tag
        const matchBefore = line.match(/^([a-zA-Z0-9_-]{3,20})\s*(?:\[|\(|\{|\(|\||l|I|1|\\|\/)/);
        if (matchBefore) {
            playerName = cleanName(matchBefore[1]);
        } else {
            // Après le tag
            const matchAfter = line.match(/(?:\]|\)|\}|\)|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{3,20})/);
            if (matchAfter) {
                playerName = cleanName(matchAfter[1]);
            }
        }
    }
    
    // 3. Détection du numéro de serveur (ex: #1061, H1061, S1061...)
    // Corrige le cas où le '0' est lu comme 'O' ou 'o'
    const serverMatch = text.match(/(?:#|No|No\.|N°|S|H|h)\s*([0-9oO]{3,5})/i);
    if (serverMatch) {
        const cleanDigits = serverMatch[1].replace(/[oO]/g, '0');
        serverNumber = ` #${cleanDigits}`;
    }
    
    return {
        guildTag,
        playerName,
        serverNumber: serverNumber.trim()
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
