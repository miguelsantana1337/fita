# FITA

Aplicativo para extrair o áudio de vídeos públicos do YouTube, individualmente ou em lotes de até 50 faixas. O projeto oferece dois modos:

- **Local:** roda em `127.0.0.1`, usa a conexão do computador e salva pelo navegador.
- **Online:** usa Neon Auth e Postgres, Vercel Functions, Vercel Sandbox e Vercel Blob privado.

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
- `YTDLP_PROXY_URL`

`YTDLP_PROXY_URL` deve apontar para uma saída residencial dedicada, em formato aceito pelo `yt-dlp`, por exemplo `http://usuario:senha@host:porta` ou `socks5://usuario:senha@host:porta`. Mantenha essa variável somente nos ambientes secretos da Vercel; nunca a salve no repositório.

IPs comuns de datacenter podem receber a tela “confirme que você não é um robô” do YouTube. Sem `YTDLP_PROXY_URL`, a API responde `503` antes de criar Sandboxes, evitando consumo inútil. Não é recomendado usar cookies da conta pessoal do YouTube em servidores compartilhados.

Para preparar e publicar:

```bash
npm install
npm run migrate
npm test
vercel deploy --prod
```

Os downloads online exigem conta. Cada usuário só acessa os próprios lotes e arquivos; os objetos são privados e os links assinados expiram em dez minutos.

## Download em massa

Abra a aba **Em massa** para colar até 50 links, um por linha. Também é possível colar URLs de playlists: o FITA expande as primeiras 50 faixas públicas e remove vídeos repetidos automaticamente.

- **Leve:** 2 downloads simultâneos.
- **Rápida:** 3 downloads simultâneos (padrão).
- **Turbo:** 4 downloads simultâneos.

Cada faixa usa até quatro fragmentos paralelos quando o formato do vídeo permite. Uma falha não interrompe as demais; itens com erro podem ser tentados novamente. Ao final, use **Baixar tudo em ZIP** para reunir os arquivos prontos sem recomprimir o áudio.

O processamento continua local. Os arquivos temporários agora expiram duas horas depois que o lote termina, e trabalhos ativos nunca são removidos pela limpeza automática.

## Formatos

- MP3: maior compatibilidade.
- M4A: boa qualidade e tamanho reduzido em dispositivos Apple.
- Opus: maior eficiência, mas compatibilidade menor em aparelhos antigos.

Escolher uma taxa acima da qualidade do áudio original não recupera detalhes que não existem na fonte.
