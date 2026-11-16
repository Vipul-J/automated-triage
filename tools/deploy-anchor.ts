import "dotenv/config";
import { readFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import solc from "solc";
import { z } from "zod";

const url = process.env.CHAIN_RPC_URL;
const key = process.env.CHAIN_PRIVATE_KEY;
if (!url || !key) throw new Error("Set CHAIN_RPC_URL and CHAIN_PRIVATE_KEY for the test chain");

const source = await readFile(new URL("../contracts/DecisionAnchor.sol", import.meta.url), "utf8");
const compile = solc.compile as (input: string) => string;
const compiled = z
  .object({
    contracts: z.object({
      "DecisionAnchor.sol": z.object({
        DecisionAnchor: z.object({
          evm: z.object({ bytecode: z.object({ object: z.string().min(1) }) }),
        }),
      }),
    }),
  })
  .parse(
    JSON.parse(
      compile(
        JSON.stringify({
          language: "Solidity",
          sources: { "DecisionAnchor.sol": { content: source } },
          settings: {
            evmVersion: "shanghai",
            outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
          },
        }),
      ),
    ),
  );

const provider = new JsonRpcProvider(url);
try {
  const bytecode = compiled.contracts["DecisionAnchor.sol"].DecisionAnchor.evm.bytecode.object;
  const factory = new ContractFactory([], "0x" + bytecode, new Wallet(key, provider));
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  console.log(`CHAIN_CONTRACT_ADDRESS=${await contract.getAddress()}`);
} finally {
  provider.destroy();
}
