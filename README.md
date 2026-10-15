# FITA

Aplicativo para extrair o áudio de vídeos públicos do YouTube, individualmente ou em lotes de até 50 faixas. O projeto oferece dois modos e uma arquitetura híbrida:

- **Local:** roda em `127.0.0.1`, usa a conexão do computador e salva pelo navegador.
- **Online híbrido:** a interface, autenticação, fila e arquivos ficam online; um worker no Mac processa a mídia usando a conexão local e envia o resultado diretamente ao Vercel Blob privado.

> Use apenas em conteúdos próprios, autorizados, em domínio público ou cuja licença/lei permita o download. Você é responsável por cumprir os termos do YouTube e os direitos autorais aplicáveis.

## Início rápido no macOS

1. Abra esta pasta no Finder.
2. Dê dois cliques em `start.command`.
3. Na primeira execução, o FITA baixa o executável oficial mais recente do `yt-dlp` para uma pasta isolada.
4. A interface abre em `http://127.0.0.1:4173`.

Se o macOS impedir a primeira abertura, clique com o botão direito em `start.command`, escolha **Abrir** e confirme.

## Pelo Terminal

```bash
npm run setup
npm start
```

Abra `http://127.0.0.1:4173`. Pressione `Ctrl+C` no Terminal para encerrar.

## Requisitos

- macOS ou Linux com Node.js 20+ (o servidor também funciona no Windows pelo Terminal).
- `ffmpeg` disponível no PATH. No macOS com Homebrew: `brew install ffmpeg`.
- Acesso à internet durante a instalação e os downloads.

O `yt-dlp` fica em `.tools`, dentro do projeto. Nenhum serviço externo próprio recebe os links. Os arquivos intermediários ficam em `.runtime`; o arquivo final é salvo pela configuração normal de downloads do seu navegador.

## Versão online

A publicação online exige estas variáveis no projeto Vercel:

- `DATABASE_URL`
- `NEON_AUTH_BASE_URL`
- `NEON_AUTH_JWKS_URL`
- `SANDBOX_SNAPSHOT_ID`
- `BLOB_READ_WRITE_TOKEN`
- `FITA_WORKER_TOKEN` — segredo aleatório compartilhado somente entre a API e o worker local

Para ativar os dois espaços de publicidade com Google AdSense, configure também:

- `ADSENSE_CLIENT_ID` — identificador no formato `ca-pub-...`
- `ADSENSE_SLOT_TOP` — ID do bloco horizontal após a abertura
- `ADSENSE_SLOT_INLINE` — ID do bloco após a área de downloads

Sem esses três valores, o layout mantém espaços identificados como publicidade, mas não carrega scripts nem exibe campanhas fictícias.

O segredo também deve existir em `.env.worker.local` no Mac, arquivo ignorado pelo Git. A API entrega uma reserva temporária para cada tarefa e um token de upload limitado a um único caminho privado. O worker não abre portas no computador e não recebe o token geral do Blob.

Para preparar e publicar:

```bash
npm install
npm run migrate
npm test
vercel deploy --prod
```

## Worker no Mac

Depois de publicar a API, prepare `.env.worker.local`:

```dotenv
FITA_BASE_URL=https://fita-azure.vercel.app
FITA_WORKER_TOKEN=mesmo-segredo-configurado-na-vercel
FITA_WORKER_CONCURRENCY=3
FITA_WORKER_LABEL=Mac principal
```

Inicie com dois cliques em `start-worker.command` ou pelo Terminal:

```bash
npm run start:worker
```

O worker envia um heartbeat a cada 25 segundos, reserva tarefas por tempo limitado, processa até quatro faixas em paralelo e renova a reserva enquanto trabalha. Se o Mac estiver desligado, as tarefas permanecem na fila e continuam quando ele voltar.

A navegação e a consulta de uma faixa são públicas. A conta é solicitada somente quando a pessoa inicia um download individual ou em lote. Cada usuário só acessa os próprios lotes e arquivos; os objetos são privados e os links assinados expiram em dez minutos.

## Download em massa

Abra a aba **Em massa** para colar até 50 links, um por linha. Também é possível colar URLs de playlists: o FITA expande as primeiras 50 faixas públicas e remove vídeos repetidos automaticamente.

- **Leve:** 2 downloads simultâneos.
- **Rápida:** 3 downloads simultâneos (padrão).
- **Turbo:** 4 downloads simultâneos.

Cada faixa usa até quatro fragmentos paralelos quando o formato do vídeo permite. Uma falha não interrompe as demais; itens com erro podem ser tentados novamente. Ao final, use **Baixar tudo em ZIP** para reunir os arquivos prontos sem recomprimir o áudio.

O processamento continua local e os arquivos temporários do worker são removidos depois do upload. Playlists são expandidas pelo Mac antes de suas faixas entrarem na fila.

## Formatos

- MP3: maior compatibilidade.
- M4A: boa qualidade e tamanho reduzido em dispositivos Apple.
- Opus: maior eficiência, mas compatibilidade menor em aparelhos antigos.

Escolher uma taxa acima da qualidade do áudio original não recupera detalhes que não existem na fonte.
