# FITA

Aplicativo local para extrair o áudio de um vídeo público do YouTube e baixar o arquivo pelo navegador. O servidor escuta somente em `127.0.0.1`, usa `yt-dlp` para obter o conteúdo e `ffmpeg` para converter o áudio.

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

O `yt-dlp` fica em `.tools`, dentro do projeto. Nenhum serviço externo próprio recebe os links. Os arquivos intermediários ficam em `.runtime` e expiram 30 minutos depois; o arquivo final é salvo pela configuração normal de downloads do seu navegador.

## Formatos

- MP3: maior compatibilidade.
- M4A: boa qualidade e tamanho reduzido em dispositivos Apple.
- Opus: maior eficiência, mas compatibilidade menor em aparelhos antigos.

Escolher uma taxa acima da qualidade do áudio original não recupera detalhes que não existem na fonte.
