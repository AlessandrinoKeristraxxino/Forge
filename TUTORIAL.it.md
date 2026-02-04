# Forge Tutorial (IT)

Tutorial pratico per imparare Forge, dalla base alle funzioni avanzate.

Nota: alcune funzioni avanzate sono in sviluppo nella runtime MVP. La sintassi qui e "target language".

## 1) Moduli: disable / able

```forge
disable 'AllInOne';
able 'Math', 'Time', 'Sys';
```

- `disable 'AllInOne'` disattiva il bundle completo.
- `able 'X'` abilita solo i moduli che vuoi usare.

## 2) Commenti

```forge
// Commento singola riga

** Commento multilinea custom
 * Ciao
**

/*
  Commento multilinea stile C
*/
```

## 3) Variabili e namespace (l / v / c)

```forge
let dog = 'Fuffy Let';
var dog = 'Fuffy Var';
const dog = 'Fuffy Const';

console.text.var(v.dog);
console.text.var(l.dog);
console.text.var(c.dog);
```

- `let` -> store `l.`
- `var` -> store `v.`
- `const` -> store `c.`

Caso estremo (nome variabile uguale a `v`):

```forge
var v = {
  dog: 'Fuffy',
  woman: 'Mia'
};

console.text.var(v.\v.dog);
```

## 4) Booleani speciali

```forge
chekBoolean(l.dog);   // False

l.dog = ?isBoolean;   // query: controlla se e booleano
l.dog = isBoolean;    // cast default
l.dog = isBoolean.f;  // cast forzato a False
l.dog = isBoolean.t;  // cast forzato a True
```

## 5) If / Elif / Else

```forge
if (l.dog !isBoolean) {
  l.dog = isBoolean.f;
} elif (l.dog ?isBoolean.t) {
  l.dog = isBoolean.t;
} else {
  console.text.var({l.dog});
}
```

## 6) Operatori matematici

- `+` addizione
- `-` sottrazione
- `x` moltiplicazione
- `/` divisione
- `%` resto
- `§` radice quadrata (operator custom)

## 7) Input da terminale

```forge
const name = inp('Quale e il tuo nome? >> ');
let inputVar = inp.var('Scrivi qualcosa, {c.name} >> ');
let inputDue = inp('>> ');
```

## 8) Time + Sys (esempio FPS dinamico)

```forge
able 'Time', 'Sys';

let ram = {
  GB: Sys.chek.ram.GB,
  comp: Sys.chek.ram.comp
};

if (l.ram.comp == Sys.chek.ram.comp('NVIDIA')) {
  if (l.ram.GB <= 4) {
    Time.set.fps(10);
  } elif (l.ram.GB <= 10) {
    Time.set.fps(20);
  } else {
    Time.set.fps(30);
  }
}

Time.wait(1s);
```

## 9) Funzioni

```forge
func saluta(nome) {
  return 'Ciao ' + nome + '!';
}

let msg = saluta('Mario');
console.text.var({l.msg});
```

## 10) File / Net / Crypto / Math (quick start)

```forge
able 'File', 'Net', 'Crypto', 'Math';

let content = File.read('input.txt');
File.write('output.txt', 'Test');

let res = Net.get('https://api.example.com/data');
console.text.var({l.res.body});

let sha = Crypto.hash.sha256('password123');
console.text.var({l.sha});

let power = Math.pow(2, 8);
console.text.var({l.power});
```

## 11) Loop base

```forge
for (let i = 0; i < 3; i = i + 1) {
  console.text.var({l.i});
}

let counter = 0;
while (l.counter < 3) {
  console.text.var({l.counter});
  l.counter = l.counter + 1;
}
```

## 12) Gestione errori

```forge
try {
  let result = File.read('file_inesistente.txt');
} catch (error) {
  console.text.var('Errore: {l.error.message}');
} finally {
  console.text.var('Operazione completata');
}
```

---

## Mini progetto consigliato

1. Leggi config da JSON (`File.read.json`)
2. Controlla RAM (`Sys.chek.ram.*`)
3. Setta FPS (`Time.set.fps`)
4. Fai una GET (`Net.get`)
5. Salva output (`File.write`)

Se vuoi, nel prossimo step ti preparo anche:
- versione "solo feature MVP"
- cheatsheet 1 pagina
- esercizi guidati con soluzioni.
