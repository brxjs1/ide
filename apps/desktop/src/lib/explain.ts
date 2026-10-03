/**
 * Gerador próprio de explicações de erros do compilador: transforma a mensagem crua do
 * TypeScript (e dos erros mais comuns do Rust) em português claro — o que aconteceu,
 * por que, como resolver e um exemplo —, usando os nomes e tipos citados na mensagem.
 */

export interface Explanation {
  /** "TS2322", "E0308"... */
  code: string;
  /** Frase curta, para o Error Lens. */
  title: string;
  /** O que aconteceu, com os nomes e tipos do erro. */
  summary: string;
  why: string;
  fixes: string[];
  example?: { bad: string; good: string };
  /** Mensagem original do compilador. */
  original: string;
}

export interface DiagnosticLike {
  code?: string | null;
  message: string;
  source?: string | null;
}

/** Trechos citados na mensagem: 'x' no TypeScript, `x` no Rust. */
function quoted(message: string, quote: "'" | "`"): string[] {
  const out: string[] = [];
  const re = quote === "'" ? /'([^']*)'/g : /`([^`]*)`/g;
  for (const m of message.matchAll(re)) out.push(m[1]!);
  return out;
}

const numbers = (message: string) => [...message.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));

type Args = { q: (i: number) => string; n: (i: number) => number; message: string };
type Entry = {
  title: (a: Args) => string;
  summary: (a: Args) => string;
  why: string;
  fixes: (a: Args) => string[];
  example?: { bad: string; good: string };
};

const TS: Record<string, Entry> = {
  "2322": {
    title: (a) => `Tipo ${a.q(0)} não cabe em ${a.q(1)}`,
    summary: (a) => `Você está usando um valor do tipo \`${a.q(0)}\` onde o código espera \`${a.q(1)}\`.`,
    why: "O TypeScript compara o tipo do valor com o tipo declarado (da variável, do parâmetro, do retorno ou da propriedade). Se um não é compatível com o outro, ele para aqui em vez de deixar o erro aparecer em produção.",
    fixes: (a) => [
      `Converta o valor para \`${a.q(1)}\` (ex.: \`Number(x)\`, \`String(x)\`) se ele vem de outra fonte.`,
      `Se o tipo declarado está errado, ajuste a declaração para aceitar \`${a.q(0)}\`.`,
      "Se o valor pode ser de vários tipos, estreite com uma verificação (`typeof`, `in`, `instanceof`) antes de usar.",
    ],
    example: { bad: 'let idade: number = "30";', good: 'let idade: number = Number("30");' },
  },
  "2345": {
    title: (a) => `Argumento ${a.q(0)} não serve para ${a.q(1)}`,
    summary: (a) => `A função espera um argumento do tipo \`${a.q(1)}\`, mas recebeu \`${a.q(0)}\`.`,
    why: "Cada parâmetro tem um tipo; o argumento passado precisa ser compatível com ele.",
    fixes: (a) => [
      `Passe um valor do tipo \`${a.q(1)}\` (converta ou valide antes).`,
      "Confira a ordem dos argumentos: talvez dois estejam trocados.",
      "Se o valor pode ser `undefined`/`null`, trate esse caso antes da chamada.",
    ],
    example: { bad: 'somar("1", 2);', good: "somar(1, 2);" },
  },
  "2339": {
    title: (a) => `${a.q(1)} não tem a propriedade ${a.q(0)}`,
    summary: (a) => `Você acessou \`.${a.q(0)}\`, mas o tipo \`${a.q(1)}\` não declara essa propriedade.`,
    why: "O TypeScript só deixa acessar propriedades que existem no tipo conhecido do valor.",
    fixes: (a) => [
      "Confira a grafia do nome (maiúsculas contam).",
      `Se a propriedade existe de fato, acrescente-a ao tipo/interface \`${a.q(1)}\`.`,
      "Se o valor é de uma união, estreite o tipo antes (ex.: `if (\"campo\" in obj)`).",
    ],
    example: { bad: "usuario.nomee", good: "usuario.nome" },
  },
  "2551": {
    title: (a) => `${a.q(0)} não existe — quis dizer ${a.q(2)}?`,
    summary: (a) => `A propriedade \`${a.q(0)}\` não existe em \`${a.q(1)}\`; o nome mais parecido é \`${a.q(2)}\`.`,
    why: "Quase sempre é um erro de digitação.",
    fixes: (a) => [`Troque por \`${a.q(2)}\`.`],
  },
  "2304": {
    title: (a) => `${a.q(0)} não está definido`,
    summary: (a) => `O nome \`${a.q(0)}\` é usado, mas não foi declarado nem importado neste escopo.`,
    why: "Todo nome precisa existir antes de ser usado: declarado no arquivo, importado ou global.",
    fixes: (a) => [
      `Importe \`${a.q(0)}\` do módulo onde ele está.`,
      "Confira a grafia e se a declaração está num escopo visível daqui.",
      "Se é uma global de ambiente (ex.: `process`, `window`), instale/inclua os tipos (`@types/node`, `lib: [\"dom\"]`).",
    ],
  },
  "2552": {
    title: (a) => `${a.q(0)} não existe — quis dizer ${a.q(1)}?`,
    summary: (a) => `O nome \`${a.q(0)}\` não foi encontrado; o mais parecido é \`${a.q(1)}\`.`,
    why: "Provável erro de digitação.",
    fixes: (a) => [`Troque por \`${a.q(1)}\`.`],
  },
  "2554": {
    title: (a) => `Esperava ${a.n(0)} argumento(s), recebeu ${a.n(1)}`,
    summary: (a) => `A função foi chamada com ${a.n(1)} argumento(s), mas declara ${a.n(0)}.`,
    why: "Argumentos a mais ou a menos geralmente indicam uma chamada desatualizada depois de mudar a assinatura.",
    fixes: () => [
      "Passe os argumentos que faltam (ou remova os que sobram).",
      "Se algum deve ser opcional, marque-o com `?` ou dê um valor padrão na declaração.",
    ],
    example: { bad: "function oi(nome: string) {}\noi();", good: 'function oi(nome = "mundo") {}\noi();' },
  },
  "2531": {
    title: () => "O valor pode ser null",
    summary: () => "Você está usando um valor que pode ser `null` como se ele sempre existisse.",
    why: "Com `strictNullChecks`, o TypeScript obriga a tratar o caso nulo antes de acessar o valor.",
    fixes: () => [
      "Verifique antes: `if (valor) { ... }`.",
      "Use encadeamento opcional (`valor?.campo`) ou um padrão (`valor ?? padrão`).",
    ],
    example: { bad: 'document.querySelector("#x").textContent', good: 'document.querySelector("#x")?.textContent' },
  },
  "2532": {
    title: () => "O valor pode ser undefined",
    summary: () => "Você está usando um valor que pode ser `undefined` como se ele sempre existisse.",
    why: "Com `strictNullChecks`, o TypeScript obriga a tratar o caso de ausência antes de usar.",
    fixes: () => ["Verifique antes (`if (valor)`), use `?.` ou forneça um padrão com `??`."],
    example: { bad: "lista[0].nome", good: 'lista[0]?.nome ?? "—"' },
  },
  "18047": {
    title: (a) => `${a.q(0)} pode ser null`,
    summary: (a) => `\`${a.q(0)}\` pode ser \`null\` neste ponto.`,
    why: "Com `strictNullChecks`, o TypeScript obriga a tratar o caso nulo.",
    fixes: (a) => [`Verifique com \`if (${a.q(0)})\`, use \`${a.q(0)}?.\` ou um padrão com \`??\`.`],
  },
  "18048": {
    title: (a) => `${a.q(0)} pode ser undefined`,
    summary: (a) => `\`${a.q(0)}\` pode ser \`undefined\` neste ponto.`,
    why: "Parâmetros opcionais, buscas em listas e campos opcionais podem não ter valor.",
    fixes: (a) => [`Verifique com \`if (${a.q(0)})\`, use \`${a.q(0)}?.\` ou um padrão com \`??\`.`],
  },
  "18046": {
    title: (a) => `${a.q(0)} é unknown`,
    summary: (a) => `\`${a.q(0)}\` tem tipo \`unknown\`: é preciso descobrir o tipo antes de usar.`,
    why: "`unknown` é o `any` seguro: aceita qualquer coisa, mas não deixa usar sem verificar.",
    fixes: (a) => [
      `Estreite o tipo: \`typeof ${a.q(0)} === "string"\`, \`${a.q(0)} instanceof Error\`, \`"campo" in ${a.q(0)}\`.`,
      "Valide dados externos com um esquema (zod, valibot) que devolve o tipo certo.",
    ],
    example: { bad: "catch (e) { console.log(e.message) }", good: "catch (e) { if (e instanceof Error) console.log(e.message) }" },
  },
  "2571": {
    title: () => "Valor do tipo unknown",
    summary: () => "O valor tem tipo `unknown`: é preciso descobrir o tipo antes de usar.",
    why: "`unknown` não deixa usar o valor sem uma verificação de tipo.",
    fixes: () => ["Estreite com `typeof`, `instanceof` ou `in` antes de acessar."],
  },
  "7006": {
    title: (a) => `Parâmetro ${a.q(0)} sem tipo`,
    summary: (a) => `O parâmetro \`${a.q(0)}\` não tem tipo declarado e virou \`any\` implicitamente.`,
    why: "Com `noImplicitAny`, parâmetros sem tipo são erro: o `any` desligaria a verificação dentro da função.",
    fixes: (a) => [`Declare o tipo: \`(${a.q(0)}: string) => ...\`.`, "Se for um callback, tipar a função que o recebe também resolve."],
    example: { bad: "function dobro(x) { return x * 2; }", good: "function dobro(x: number) { return x * 2; }" },
  },
  "7031": {
    title: (a) => `${a.q(0)} sem tipo na desestruturação`,
    summary: (a) => `\`${a.q(0)}\` vem de uma desestruturação sem tipo e virou \`any\`.`,
    why: "Com `noImplicitAny`, cada parte desestruturada precisa de tipo.",
    fixes: () => ["Tipe o objeto inteiro: `({ nome, idade }: { nome: string; idade: number })`."],
  },
  "7053": {
    title: () => "Índice sem tipo conhecido",
    summary: (a) => `Uma expressão do tipo \`${a.q(1) || a.q(0)}\` está sendo usada como índice de um objeto que não declara essas chaves.`,
    why: "Indexar com uma string qualquer pode acessar chaves inexistentes; o resultado vira `any`.",
    fixes: () => [
      "Restrinja a chave: `chave as keyof typeof obj`, ou declare o tipo da chave como uma união dos nomes válidos.",
      "Se o objeto é um mapa dinâmico, declare-o como `Record<string, Valor>`.",
    ],
    example: { bad: "const cores = { a: 1 }; cores[nome];", good: "const cores: Record<string, number> = { a: 1 }; cores[nome];" },
  },
  "2307": {
    title: (a) => `Módulo ${a.q(0)} não encontrado`,
    summary: (a) => `O import de \`${a.q(0)}\` não acha o arquivo nem os tipos do pacote.`,
    why: "O caminho está errado, o pacote não foi instalado, ou ele não tem declarações de tipo.",
    fixes: (a) => [
      "Para arquivos locais, confira o caminho relativo (`./`, `../`) e a extensão.",
      `Para pacotes, instale: \`pnpm add ${a.q(0)}\` (e \`pnpm add -D @types/${a.q(0)}\` se os tipos forem separados).`,
    ],
  },
  "2305": {
    title: (a) => `${a.q(0)} não exporta ${a.q(1)}`,
    summary: (a) => `O módulo \`${a.q(0)}\` não tem um export chamado \`${a.q(1)}\`.`,
    why: "O nome mudou, não é exportado, ou é um export default.",
    fixes: (a) => [`Confira os exports de \`${a.q(0)}\`.`, `Se for default: \`import ${a.q(1)} from "${a.q(0)}"\`.`],
  },
  "2614": {
    title: (a) => `${a.q(1)} é o export default`,
    summary: (a) => `\`${a.q(0)}\` não tem export nomeado \`${a.q(1)}\`; provavelmente é o export default.`,
    why: "Imports com chaves pegam exports nomeados; o default é importado sem chaves.",
    fixes: (a) => [`Use \`import ${a.q(1)} from "${a.q(0)}"\`.`],
  },
  "6133": {
    title: (a) => `${a.q(0)} declarado e nunca usado`,
    summary: (a) => `\`${a.q(0)}\` é declarado, mas o valor nunca é lido.`,
    why: "Código morto confunde quem lê e às vezes indica que faltou usar o valor.",
    fixes: (a) => [`Remova \`${a.q(0)}\`, ou use-o onde era a intenção.`, "Para parâmetros obrigatórios pela assinatura, prefixe com `_`."],
  },
  "6196": {
    title: (a) => `${a.q(0)} declarado e nunca usado`,
    summary: (a) => `O tipo \`${a.q(0)}\` é declarado, mas nunca usado.`,
    why: "Declarações sem uso são ruído.",
    fixes: (a) => [`Remova \`${a.q(0)}\` ou exporte-o se for usado em outro lugar.`],
  },
  "2741": {
    title: (a) => `Falta a propriedade ${a.q(0)}`,
    summary: (a) => `O objeto do tipo \`${a.q(1)}\` não tem \`${a.q(0)}\`, que é obrigatória em \`${a.q(2)}\`.`,
    why: "Propriedades sem `?` na interface são obrigatórias.",
    fixes: (a) => [`Inclua \`${a.q(0)}\` no objeto.`, `Se ela não é obrigatória, marque-a como opcional (\`${a.q(0)}?:\`) na interface.`],
    example: { bad: 'const u: Usuario = { nome: "Ana" };', good: 'const u: Usuario = { nome: "Ana", email: "ana@x.com" };' },
  },
  "2739": {
    title: () => "Faltam propriedades obrigatórias",
    summary: (a) => `O tipo \`${a.q(0)}\` não tem propriedades exigidas por \`${a.q(1)}\`: ${a.message.split(":").pop()?.trim() ?? ""}`,
    why: "O objeto precisa ter todas as propriedades obrigatórias do tipo de destino.",
    fixes: () => ["Inclua as propriedades listadas, ou torne-as opcionais na interface."],
  },
  "2740": {
    title: () => "Faltam propriedades obrigatórias",
    summary: (a) => `O tipo \`${a.q(0)}\` não tem várias propriedades exigidas por \`${a.q(1)}\`.`,
    why: "O objeto precisa ter todas as propriedades obrigatórias do tipo de destino.",
    fixes: () => ["Inclua as propriedades que faltam, ou confira se o tipo de destino é o certo."],
  },
  "2353": {
    title: (a) => `${a.q(0)} não existe em ${a.q(1)}`,
    summary: (a) => `O objeto literal tem \`${a.q(0)}\`, que o tipo \`${a.q(1)}\` não declara.`,
    why: "Em objetos literais, propriedades a mais costumam ser erro de digitação ou de tipo.",
    fixes: (a) => ["Confira a grafia.", `Se a propriedade é válida, acrescente-a a \`${a.q(1)}\`.`],
  },
  "2769": {
    title: () => "Nenhuma assinatura aceita estes argumentos",
    summary: () => "A função tem várias assinaturas (overloads) e nenhuma combina com os argumentos passados.",
    why: "O TypeScript testa cada assinatura; a mensagem completa mostra por que cada uma falhou.",
    fixes: () => ["Leia o detalhe do último overload na mensagem original: ele costuma apontar o argumento errado.", "Confira tipos e quantidade dos argumentos."],
  },
  "2367": {
    title: (a) => `${a.q(0)} e ${a.q(1)} nunca são iguais`,
    summary: (a) => `A comparação entre \`${a.q(0)}\` e \`${a.q(1)}\` sempre dá o mesmo resultado: os tipos não têm valor em comum.`,
    why: "Comparar tipos sem sobreposição quase sempre é um bug (variável errada, ou valor que já foi estreitado antes).",
    fixes: () => ["Confira se está comparando a variável certa.", "Se o valor vem de fora, ajuste o tipo declarado para incluir o caso comparado."],
  },
  "2564": {
    title: (a) => `${a.q(0)} sem valor inicial`,
    summary: (a) => `A propriedade \`${a.q(0)}\` não é inicializada nem no construtor.`,
    why: "Com `strictPropertyInitialization`, toda propriedade precisa de valor ao criar o objeto.",
    fixes: (a) => [
      `Inicialize na declaração (\`${a.q(0)} = ...\`) ou no construtor.`,
      `Se ela pode faltar, declare como opcional (\`${a.q(0)}?:\`).`,
      `Se outro código garante a inicialização, use \`${a.q(0)}!:\` (com cuidado).`,
    ],
  },
  "2454": {
    title: (a) => `${a.q(0)} usado antes de receber valor`,
    summary: (a) => `\`${a.q(0)}\` pode estar sem valor neste ponto.`,
    why: "Em algum caminho do código a variável não é atribuída antes do uso.",
    fixes: (a) => [`Dê um valor inicial a \`${a.q(0)}\`, ou garanta a atribuição em todos os caminhos (inclusive no else).`],
  },
  "2448": {
    title: (a) => `${a.q(0)} usado antes da declaração`,
    summary: (a) => `\`${a.q(0)}\` (let/const) é usado antes da linha em que é declarado.`,
    why: "Variáveis com `let`/`const` não existem antes da declaração (zona morta temporal).",
    fixes: (a) => [`Mova a declaração de \`${a.q(0)}\` para antes do uso.`],
  },
  "2349": {
    title: () => "Isso não é uma função",
    summary: () => "Você está chamando com `()` um valor cujo tipo não é uma função.",
    why: "Só funções (ou objetos com assinatura de chamada) podem ser chamadas.",
    fixes: () => ["Confira se o valor é mesmo a função (talvez seja o resultado dela).", "Se é uma união, estreite para o caso função antes de chamar."],
  },
  "2351": {
    title: () => "Isso não é uma classe",
    summary: () => "Você usou `new` num valor que não é construtor.",
    why: "Só classes e funções construtoras podem ser usadas com `new`.",
    fixes: () => ["Confira o import (default × nomeado) e se o valor é a classe certa."],
  },
  "2365": {
    title: (a) => `${a.q(0)} não funciona entre ${a.q(1)} e ${a.q(2)}`,
    summary: (a) => `O operador \`${a.q(0)}\` não pode ser usado com \`${a.q(1)}\` e \`${a.q(2)}\`.`,
    why: "Operadores aritméticos e de comparação exigem tipos compatíveis.",
    fixes: () => ["Converta os operandos para o mesmo tipo (`Number(x)`, `String(x)`) antes da operação."],
  },
  "2362": {
    title: () => "Operando esquerdo não numérico",
    summary: () => "O lado esquerdo da operação aritmética precisa ser `number`, `bigint`, `any` ou enum.",
    why: "Aritmética em outros tipos dá resultados sem sentido (ex.: datas, strings).",
    fixes: () => ["Converta para número (`Number(x)`, `data.getTime()`)."],
  },
  "2363": {
    title: () => "Operando direito não numérico",
    summary: () => "O lado direito da operação aritmética precisa ser `number`, `bigint`, `any` ou enum.",
    why: "Aritmética em outros tipos dá resultados sem sentido.",
    fixes: () => ["Converta para número (`Number(x)`, `data.getTime()`)."],
  },
  "2588": {
    title: (a) => `${a.q(0)} é constante`,
    summary: (a) => `\`${a.q(0)}\` foi declarado com \`const\` e não pode receber outro valor.`,
    why: "`const` impede reatribuição (o conteúdo de objetos ainda pode mudar).",
    fixes: (a) => [`Declare \`${a.q(0)}\` com \`let\` se ele precisa mudar, ou crie outra variável.`],
  },
  "2540": {
    title: (a) => `${a.q(0)} é somente leitura`,
    summary: (a) => `A propriedade \`${a.q(0)}\` é \`readonly\` e não pode ser alterada.`,
    why: "Propriedades `readonly` protegem dados que não devem mudar depois de criados.",
    fixes: () => ["Crie um objeto novo com o valor alterado (`{ ...obj, campo: novo }`), em vez de mudar o existente."],
  },
  "2355": {
    title: () => "A função precisa retornar um valor",
    summary: () => "O tipo de retorno declarado exige um valor, mas algum caminho termina sem `return`.",
    why: "Todo caminho da função precisa devolver o tipo declarado.",
    fixes: () => ["Adicione `return` nos caminhos que faltam (inclusive no final).", "Se nem sempre há valor, inclua `undefined` no tipo de retorno."],
  },
  "2366": {
    title: () => "Falta return no fim da função",
    summary: () => "A função pode chegar ao fim sem retornar, e o tipo de retorno não aceita `undefined`.",
    why: "Algum caminho (geralmente o final, ou um switch sem default) não retorna.",
    fixes: () => ["Adicione um `return` (ou `throw`) ao final.", "Ou inclua `undefined` no tipo de retorno."],
  },
  "1308": {
    title: () => "await fora de função async",
    summary: () => "`await` só pode ser usado dentro de uma função `async` (ou no topo de um módulo ES).",
    why: "`await` pausa a função; só funções `async` podem ser pausadas.",
    fixes: () => ["Marque a função como `async`.", "Ou use `.then(...)` no lugar do `await`."],
    example: { bad: "function carregar() { const r = await fetch(url); }", good: "async function carregar() { const r = await fetch(url); }" },
  },
  "2801": {
    title: () => "Faltou await?",
    summary: () => "A condição testa uma Promise, que é sempre verdadeira; você provavelmente queria o valor dela.",
    why: "Uma Promise é um objeto: em `if (promessa)` ela é sempre verdadeira, independente do resultado.",
    fixes: () => ["Use `await` antes da chamada: `if (await verificar())`."],
  },
  "2451": {
    title: (a) => `${a.q(0)} declarado duas vezes`,
    summary: (a) => `\`${a.q(0)}\` já foi declarado neste escopo.`,
    why: "`let`/`const` não podem ser declarados duas vezes no mesmo bloco.",
    fixes: (a) => [`Renomeie uma das variáveis, ou reatribua (\`${a.q(0)} = ...\`) em vez de redeclarar.`],
  },
  "2300": {
    title: (a) => `Identificador ${a.q(0)} duplicado`,
    summary: (a) => `\`${a.q(0)}\` foi declarado mais de uma vez.`,
    why: "Dois nomes iguais no mesmo escopo são ambíguos.",
    fixes: () => ["Remova ou renomeie a duplicata."],
  },
  "2416": {
    title: (a) => `${a.q(0)} incompatível com a classe base`,
    summary: (a) => `A propriedade \`${a.q(0)}\` em \`${a.q(1)}\` não é compatível com a mesma propriedade em \`${a.q(2)}\`.`,
    why: "Subclasses precisam manter os tipos das propriedades e métodos que sobrescrevem.",
    fixes: () => ["Ajuste a assinatura para ser compatível com a da classe base."],
  },
  "2420": {
    title: (a) => `${a.q(0)} não implementa ${a.q(1)} direito`,
    summary: (a) => `A classe \`${a.q(0)}\` declara implementar \`${a.q(1)}\`, mas falta algo ou algum tipo não bate.`,
    why: "`implements` exige todos os membros da interface com tipos compatíveis.",
    fixes: () => ["Implemente os membros que faltam com as assinaturas da interface."],
  },
  "2488": {
    title: () => "Valor não iterável",
    summary: () => "Você está usando `for...of` ou `...` num valor que não é iterável.",
    why: "Só arrays, strings, Map, Set e objetos com `Symbol.iterator` podem ser percorridos assim.",
    fixes: () => ["Para objetos comuns, use `Object.entries(obj)` / `Object.values(obj)`."],
  },
  "2698": {
    title: () => "Spread só funciona com objetos",
    summary: () => "O operador `...` foi usado num valor que pode não ser objeto.",
    why: "Espalhar `undefined` ou tipos primitivos num objeto não tem significado definido para o TypeScript.",
    fixes: () => ["Garanta que o valor é objeto (`...(valor ?? {})`) ou estreite o tipo antes."],
  },
  "1005": {
    title: (a) => `Faltou ${a.q(0)}`,
    summary: (a) => `O compilador esperava \`${a.q(0)}\` aqui: a sintaxe está incompleta.`,
    why: "Erros de sintaxe costumam vir de parênteses, chaves ou vírgulas faltando um pouco antes.",
    fixes: () => ["Olhe a linha anterior: o erro real costuma estar logo antes do ponto indicado."],
  },
  "1128": {
    title: () => "Sintaxe inválida",
    summary: () => "O compilador esperava uma declaração ou instrução aqui.",
    why: "Geralmente uma chave `}` sobrando ou faltando um pouco antes.",
    fixes: () => ["Confira o balanceamento de chaves e parênteses nas linhas acima."],
  },
};

const RUST: Record<string, Entry> = {
  E0308: {
    title: (a) => (a.q(0) ? `Esperava ${a.q(0)}, recebeu ${a.q(1)}` : "Tipos incompatíveis"),
    summary: (a) =>
      a.q(0) ? `O código espera \`${a.q(0)}\`, mas o valor é \`${a.q(1)}\`.` : "O tipo do valor não é o que o código espera aqui.",
    why: "Rust não converte tipos implicitamente: o valor precisa ter exatamente o tipo esperado.",
    fixes: (a) => [
      a.q(0) ? `Converta o valor para \`${a.q(0)}\` (ex.: \`.to_string()\`, \`as\`, \`From\`/\`Into\`).` : "Converta o valor para o tipo esperado.",
      "Ou ajuste a assinatura (retorno, parâmetro) se o tipo esperado é que está errado.",
    ],
    example: { bad: "fn nome() -> String { 42 }", good: "fn nome() -> String { 42.to_string() }" },
  },
  E0382: {
    title: (a) => `${a.q(0) || "Valor"} usado depois de movido`,
    summary: (a) => `\`${a.q(0)}\` foi movido (passado por valor ou atribuído) e depois usado de novo.`,
    why: "Tipos sem `Copy` têm um único dono; ao mover, o dono anterior não pode mais usar o valor.",
    fixes: () => ["Passe uma referência (`&valor`) em vez de mover.", "Ou clone (`valor.clone()`) se precisa de duas cópias independentes."],
  },
  E0499: {
    title: () => "Dois empréstimos mutáveis ao mesmo tempo",
    summary: () => "O mesmo valor está emprestado como `&mut` duas vezes ao mesmo tempo.",
    why: "Rust permite só um `&mut` por vez, para impedir condições de corrida e invalidação de dados.",
    fixes: () => ["Termine o uso do primeiro empréstimo antes de criar o segundo (escopos menores).", "Divida o dado em partes separadas, se cada empréstimo usa uma parte."],
  },
  E0502: {
    title: () => "Empréstimos conflitantes",
    summary: () => "O valor está emprestado como imutável e mutável ao mesmo tempo.",
    why: "Enquanto existe uma referência `&`, ninguém pode alterar o valor por `&mut`.",
    fixes: () => ["Use a referência imutável até o fim antes de alterar.", "Copie/clone o dado necessário antes de pegar o `&mut`."],
  },
  E0505: {
    title: () => "Movido enquanto emprestado",
    summary: () => "O valor é movido enquanto ainda existe uma referência para ele.",
    why: "Mover invalidaria a referência ainda em uso.",
    fixes: () => ["Termine de usar a referência antes de mover, ou clone o valor."],
  },
  E0425: {
    title: (a) => `${a.q(0) || "Nome"} não encontrado`,
    summary: (a) => `\`${a.q(0)}\` não existe neste escopo.`,
    why: "O nome não foi declarado, importado com `use`, ou está escrito diferente.",
    fixes: () => ["Confira a grafia.", "Importe com `use caminho::Nome;`."],
  },
  E0433: {
    title: () => "Caminho não resolvido",
    summary: (a) => `O caminho \`${a.q(0)}\` não foi encontrado.`,
    why: "O módulo ou crate não foi declarado (`mod`), importado (`use`) ou adicionado ao Cargo.toml.",
    fixes: () => ["Adicione `use` para o módulo, ou o crate em `[dependencies]`."],
  },
  E0599: {
    title: (a) => `Método ${a.q(0)} não existe`,
    summary: (a) => `O tipo não tem o método \`${a.q(0)}\` (ou o trait que o fornece não está em escopo).`,
    why: "Métodos de traits só aparecem com o trait importado com `use`.",
    fixes: () => ["Confira a grafia.", "Importe o trait que define o método (o compilador costuma sugerir qual)."],
  },
  E0277: {
    title: () => "Trait não implementado",
    summary: (a) => `O tipo não implementa o trait exigido${a.q(1) ? ` (\`${a.q(1)}\`)` : ""}.`,
    why: "A função ou operação exige que o tipo implemente um trait.",
    fixes: () => ["Implemente o trait (`impl Trait for Tipo`) ou derive-o (`#[derive(...)]`).", "Ou converta para um tipo que já implementa."],
  },
  E0384: {
    title: (a) => `${a.q(0) || "Variável"} não é mutável`,
    summary: (a) => `\`${a.q(0)}\` recebe um novo valor, mas foi declarada sem \`mut\`.`,
    why: "Variáveis em Rust são imutáveis por padrão.",
    fixes: (a) => [`Declare como \`let mut ${a.q(0) || "x"}\`.`],
  },
  E0596: {
    title: () => "Empréstimo mutável de algo imutável",
    summary: () => "Você pegou `&mut` de um valor que não foi declarado `mut`.",
    why: "Só valores mutáveis podem ser emprestados como `&mut`.",
    fixes: () => ["Declare a variável com `mut`, ou receba `&mut self` no método."],
  },
  E0061: {
    title: () => "Número errado de argumentos",
    summary: () => "A função foi chamada com mais ou menos argumentos do que declara.",
    why: "Rust não tem argumentos opcionais nem padrão.",
    fixes: () => ["Passe exatamente os argumentos da assinatura (use `Option<T>` para os opcionais)."],
  },
  E0063: {
    title: () => "Faltam campos na struct",
    summary: (a) => `Faltam campos ao criar a struct${a.q(0) ? `: \`${a.q(0)}\`` : ""}.`,
    why: "Toda struct precisa de todos os campos na criação.",
    fixes: () => ["Inclua os campos, ou use `..Default::default()` se a struct implementa `Default`."],
  },
};

/** Explicação para o diagnóstico, se for um erro conhecido. */
export function explain(d: DiagnosticLike): Explanation | null {
  const code = (d.code ?? "").trim();
  const source = (d.source ?? "").toLowerCase();
  const isRust = /^E\d{4}$/.test(code) || source === "rustc";
  const table = isRust ? RUST : TS;
  const key = isRust ? code : code.replace(/^TS/i, "");
  const entry = table[key];
  if (!entry) return null;
  const parts = quoted(d.message, isRust ? "`" : "'");
  const nums = numbers(d.message);
  const args: Args = { q: (i) => parts[i] ?? "", n: (i) => nums[i] ?? 0, message: d.message };
  return {
    code: isRust ? key : `TS${key}`,
    title: entry.title(args),
    summary: entry.summary(args),
    why: entry.why,
    fixes: entry.fixes(args),
    example: entry.example,
    original: d.message,
  };
}

/** Códigos com explicação (para a documentação e os testes). */
export const explainedCodes = () => ({ typescript: Object.keys(TS).map((k) => `TS${k}`), rust: Object.keys(RUST) });
