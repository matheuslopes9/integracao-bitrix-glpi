# Integrador GLPI ↔ Bitrix24

Sincronização bidirecional de chamados do **GLPI** com tarefas do **Bitrix24**.

```
┌──────────┐                ┌──────────────────┐                ┌───────────┐
│  GLPI    │ ─ webhook ───▶ │  Integrador (TS) │ ──── REST ───▶ │  Bitrix24 │
│          │ ◀── REST ───── │  Express + SQLite│ ◀ webhook ─── │           │
└──────────┘                └──────────────────┘                └───────────┘
```

## O que sincroniza

| Evento no GLPI                                    | Reação no Bitrix24                          |
|---------------------------------------------------|----------------------------------------------|
| Cliente abre chamado                              | `tasks.task.add` (cria tarefa)              |
| Técnico atribuído                                 | atualiza `RESPONSIBLE_ID`                   |
| Status do chamado muda                            | atualiza `STATUS` da tarefa                 |
| Followup adicionado (resposta do atendente)       | `task.commentitem.add` na tarefa            |
| Chamado fechado/resolvido                         | `tasks.task.complete`                        |

| Evento no Bitrix24                                | Reação no GLPI                              |
|---------------------------------------------------|----------------------------------------------|
| Comentário em tarefa vinculada                    | `ITILFollowup` no ticket original           |
| Status muda para concluído                        | Fecha o ticket + cria `ITILSolution`        |
| Status muda para em progresso                     | Atualiza status do ticket                   |

Loops infinitos são evitados por um **echo-guard** com TTL de 10–15s — quando o integrador escreve em um lado, registra a chave do evento esperado de volta e ignora.

---

## Pré-requisitos

- **GLPI 10.0.7+** (com plugin nativo de Webhook em *Configurar → Notificações → Webhook*)
- **Bitrix24** com permissão para criar Webhook entrante (Aplicativos → Desenvolvedor → Outras → Webhook entrante)
- **EasyPanel** ou qualquer host Docker (porta 3000 exposta + domínio com HTTPS)
- Conta de robô (1 usuário GLPI + 1 usuário Bitrix) que vai aparecer como autor das ações automáticas

---

## 1) Subir o projeto no GitHub

```bash
# dentro da pasta do projeto
git init -b main
git remote add origin https://github.com/matheuslopes9/integracao-bitrix-glpi.git
git add .
git commit -m "feat: integrador bidirecional GLPI<->Bitrix"
git push -u origin main
```

---

## 2) Configurar o **GLPI**

### 2.1 Criar tokens de API

1. *Configurar → Geral → API*
2. Ative **Habilitar API REST**
3. Em **Clientes API**, crie um novo cliente:
   - Nome: `Integrador Bitrix`
   - Faixa IPs: deixar em branco (libera de qualquer origem; restrinja em produção)
   - **Habilitar `App-Token`**: gere e copie → `GLPI_APP_TOKEN`
4. Em *Administração → Usuários*, escolha (ou crie) um usuário com perfil **Super-Admin**:
   - Aba **Tokens pessoais** → gere um **API token** → copie → `GLPI_USER_TOKEN`

### 2.2 Configurar webhook de saída

1. *Configurar → Notificações → Webhook → +Adicionar*
2. Preencha:
   - **Nome**: `Integrador Bitrix`
   - **URL**: `https://seu-dominio-easypanel/webhooks/glpi`
   - **HTTP Method**: `POST`
   - **Custom Headers**:
     - `Content-Type: application/json`
   - **Secret**: o mesmo valor de `GLPI_WEBHOOK_SECRET` (o GLPI usa para assinar com HMAC-SHA256 e envia em `X-GLPI-Signature` ou `X-Hub-Signature-256`)
   - **Payload** (use o editor com `{{`):
     ```json
     {
       "event":    "{{event}}",
       "itemtype": "{{itemtype}}",
       "items_id": {{item.id}},
       "ticket_id": {{item.tickets_id}},
       "name":     "{{item.name}}",
       "content":  {{item.content|json}},
       "status":   {{item.status}},
       "users_id": {{item.users_id}}
     }
     ```
3. Em **Eventos**, marque (no mínimo):
   - `Ticket → add`
   - `Ticket → update`
   - `ITILFollowup → add`
4. Salve e use a aba **Preview** para validar o payload com um ticket existente.

> Dica: se o seu GLPI for ≤ 10.0.6 (sem webhook nativo), use o plugin `glpi-webhook` da comunidade.

---

## 3) Configurar o **Bitrix24**

### 3.1 Webhook entrante (o que **o integrador chama**)

1. *Aplicativos → Webhooks (ou Recursos para desenvolvedor) → +Webhook entrante*
2. Permissões: marque `tasks` (Tarefas), `task` (clássico), `user` (Usuários)
3. Copie a **URL do webhook** (algo como `https://suaempresa.bitrix24.com.br/rest/1/abcdef123456/`) → `BITRIX_WEBHOOK_URL`

### 3.2 Webhook de saída (eventos que o **Bitrix dispara para nós**)

> Bitrix24 nuvem só permite eventos de saída via **aplicativo local**, não via Webhook entrante.
> Crie um *Aplicativo local* (Aplicativos → Desenvolvedor → Outras → Aplicativo local):

1. **Handler URL**: `https://seu-dominio-easypanel/webhooks/bitrix`
2. **Token de instalação inicial**: cole o valor de `BITRIX_WEBHOOK_SECRET`
3. Permissões: `tasks`, `task`, `user`
4. Após instalar, use `event.bind` para assinar:
   - `ONTASKADD`
   - `ONTASKUPDATE`
   - `ONTASKCOMMENTADD`

Você pode disparar a partir do próprio webhook entrante:

```bash
curl -X POST "https://suaempresa.bitrix24.com.br/rest/1/abcdef123456/event.bind.json" \
  -H "Content-Type: application/json" \
  -d '{
    "event":   "ONTASKUPDATE",
    "handler": "https://seu-dominio-easypanel/webhooks/bitrix",
    "auth_type": 0
  }'
```
Repita para `ONTASKADD` e `ONTASKCOMMENTADD`.

### 3.3 Pegar o ID dos usuários

- Acesse `https://suaempresa.bitrix24.com.br/rest/1/abcdef123456/user.current.json` no navegador → use o `ID` retornado em `BITRIX_DEFAULT_CREATOR_ID` e/ou `BITRIX_DEFAULT_RESPONSIBLE_ID`.

---

## 4) Configurar `.env`

Copie `.env.example` para `.env` e preencha tudo:

```bash
cp .env.example .env
```

```env
GLPI_BASE_URL=https://glpi.seucliente.com.br
GLPI_APP_TOKEN=...
GLPI_USER_TOKEN=...
GLPI_WEBHOOK_SECRET=algumacoisalongaecreta

BITRIX_WEBHOOK_URL=https://suaempresa.bitrix24.com.br/rest/1/abcdef123456/
BITRIX_WEBHOOK_SECRET=outracoisalongaecreta
BITRIX_DEFAULT_CREATOR_ID=1
BITRIX_DEFAULT_RESPONSIBLE_ID=1
```

---

## 5) Rodar localmente (dev)

```bash
npm install
npm run dev
```

A app sobe em `http://localhost:3000`. Use [ngrok](https://ngrok.com/) ou Cloudflare Tunnel para expor durante os testes.

```bash
ngrok http 3000
```

---

## 6) Deploy no **EasyPanel**

### Opção A – pelo Docker Compose

1. No EasyPanel: **+ Create → App → Docker Compose**
2. Selecione a fonte: `Github` → escolha o repositório `matheuslopes9/integracao-bitrix-glpi`, branch `main`
3. Em **Build**, deixe **Compose** apontando para `docker-compose.yml`
4. Em **Domains**, adicione um domínio com HTTPS apontando para a porta `3000` (esse será o destino dos webhooks)
5. Em **Environment**, cole todas as variáveis do seu `.env`
6. **Deploy**. Após o build, valide com:
   ```bash
   curl https://seu-dominio-easypanel/healthz
   # {"ok":true,"ts":"2026-05-18T..."}
   ```

### Opção B – App Node nativo

1. **+ Create → App → Node.js**
2. Repositório: `https://github.com/matheuslopes9/integracao-bitrix-glpi`
3. Build command: `npm install && npm run build`
4. Start command: `node dist/index.js`
5. Adicione um **volume persistente** em `/app/data` (SQLite)
6. Configure as envs e o domínio HTTPS

---

## 7) Mapeamento de usuários (importante!)

Quando alguém é atribuído como técnico no GLPI, o integrador precisa saber qual usuário Bitrix corresponde. Sem mapeamento, ele usa `BITRIX_DEFAULT_RESPONSIBLE_ID`.

Existem 3 formas de popular a tabela `user_link`:

1. **Via SQLite direto** (mais rápido para começar):
   ```bash
   sqlite3 ./data/integrador.db
   > INSERT INTO user_link (glpi_user_id, bitrix_user_id, glpi_email) VALUES (4, 17, 'fulano@cliente.com');
   ```
2. **Por e-mail (futuro)**: o cliente `bitrixClient.findUserByEmail()` já existe; basta criar uma rota `/admin/users/sync` ou rodar um script periódico que cruza emails.
3. **Manual**: ajuste cada chamado quando o sistema marcar o "default responsible" e troque depois.

---

## 8) Testando o fluxo

1. **Abrir chamado no GLPI** → em alguns segundos aparece uma tarefa `[GLPI #123] ...` no Bitrix24
2. **Atribuir técnico no GLPI** → `RESPONSIBLE_ID` da tarefa muda
3. **Adicionar acompanhamento no GLPI** → vira comentário na tarefa do Bitrix
4. **Comentar na tarefa Bitrix** → vira `ITILFollowup` no ticket GLPI
5. **Marcar como concluída no Bitrix** → o GLPI cria `ITILSolution` e fecha o ticket
6. **Fechar/resolver o ticket no GLPI** → a tarefa Bitrix é marcada como concluída

Logs em `docker logs integrador-bitrix-glpi -f`.

---

## 9) Estrutura

```
src/
├── index.ts                  # bootstrap Express
├── config.ts                 # envs + validação Zod
├── logger.ts                 # pino
├── db.ts                     # SQLite + repositórios + echo-guard
├── clients/
│   ├── glpiClient.ts         # API REST do GLPI (initSession, Ticket, Followup, Solution)
│   └── bitrixClient.ts       # API REST do Bitrix24 (tasks.*, task.commentitem.*)
├── sync/
│   ├── glpiToBitrix.ts       # handlers: ticket criado/atualizado, followup adicionado
│   └── bitrixToGlpi.ts       # handlers: task atualizada, comentário adicionado
└── http/
    ├── routes.ts             # /webhooks/glpi, /webhooks/bitrix, /healthz
    └── verifySignature.ts    # HMAC GLPI + token Bitrix
```

---

## 10) Limitações & próximos passos

- **Sem fila**: hoje é síncrono — se o Bitrix demorar, o GLPI vai aguardar a resposta. Em alta volumetria, plugar BullMQ + Redis.
- **Anexos**: ainda não copiados (precisa de download GLPI → upload via `disk.folder.uploadfile` no Bitrix).
- **Mapeamento de usuários por email**: rota administrativa pode ser adicionada.
- **Outros itemtypes**: hoje só tratamos `Ticket`/`ITILFollowup`. Para Changes/Problems, replicar os handlers.

---

## Licença

MIT — use à vontade.
