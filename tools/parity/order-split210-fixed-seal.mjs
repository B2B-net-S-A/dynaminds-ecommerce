/** Build-only fixed seal derivation. No filesystem, database, migration
 * registration or runtime admission. Historical parent rows are immutable
 * per-install DATA, never expected catalogue metadata or a verdict. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assembleOrderSplit210Source} from './order-split210-source.mjs';
import {deriveOrderSplit210Closure,orderSplit210TaggedDescriptor} from './order-split210-closure.mjs';
import {deriveOrderSplit210AdditionOracle,assertOrderSplit210AdditionSemantics,deriveOrderSplit210ExpressionProbe} from './order-split210-addition-oracle.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const identity=r=>r.kind+'\0'+r.key;
const sorted=rs=>[...rs].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
/** Historical fourteen-change proof; never used to admit the successor. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V14=freeze({
 candidate_sha256:'f78e7d4757fc4956958eb71c5564ef313bcff860b233d4c2e01ec5c67fbf066b',candidate_bytes:869737,
 independent_expression_leaves_sha256:'1796d093cc4d6c430994d4ef89bd9eebea1cd19fa8727d1ce46b856618754d7d',
 independent_expression_probe_sha256:'2a5c6faf7e0a66166655ca9b2752edd124f1cb47eced3385963a3cb782a693f5',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'9744384245291871975d44da21db00fbd29b484375ddc8443889bbf8650bd157',
 source_expected_vector_canonical_sha256:'5e5911bd043261d7f0a57b121b41a879a91927f91b93fbdc61c26e38138e78e2',
 source_expected_vector_gzip_sha256:'6da80aebbe62021b8c756387e751b7f8be15e6de4c432a40eb09ffdbdbda717d',
 source_expected_review_sha256:'06edf6069c4a01053dd96f5187068db2c77ee0a5d0e726595d95bb2baa6c3c24',
});
// These successor47 leaves come only from the independent authored-schema
// rollback probe. No target catalogue, target verdict or Native acceptance was
// used to supply expected metadata. Vector publication remains separate proof.
/** Previous fifteen-change source expectation, before statement-local sharing.
 * Historical provenance only; it cannot admit the current candidate. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V15_BEFORE_CTE=freeze({
 candidate_sha256:'b3df2079d68bf53243d421681e54c9a35faf8356425a94cde894773c9fbdc2b9',candidate_bytes:3543023,
 independent_expression_leaves_sha256:'147b7ba6fc1717fa4f8b971eafdc76d042e3d513d28a3e251de1d5d4f28c0281',
 independent_expression_basis_sha256:'4582561d734b851e2f6edede6f3cdd4c068d3f97e8847e3bb284b920143ddc96',
 independent_expression_probe_sha256:'409361b718a3cea66b6dcba49a901a8765eae975da5d2ced67ccc3f365c9c68a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'a8a8d62038a83c51d5821e45ac53b370d3075cef9cdb9109d9d02e0f11fd5fce',
 source_expected_vector_canonical_sha256:'76ff587e94916e6fd1c5ea19eca537c504e1e84d207704af335734036a4f39e3',
 source_expected_vector_gzip_sha256:'856abe82b1ac00faf13ccc91701a4f445ea5f92910d0207aceb0e451ef04266d',
 // Historical property name: this is the SOURCE_EXPECTATION_PREPARED_NOT_COMPILED
 // result, not a target compilation/full-inverse review or Native receipt.
 source_expected_review_sha256:'478b64359c29d8bdeb008af03dbebe2e35a7275bf63531e435ae6d80bbdadcab',
});
/** Historical C08/C09 expectation before manual169 correction and snapshot sharing. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V15_BEFORE_SNAPSHOT=freeze({
 candidate_sha256:'c257bd5c4a24d0a24be338e3c26cff61414bd42cdd6df65a103df6f8844b2113',candidate_bytes:3553973,
 independent_expression_leaves_sha256:'da1a2e32e41c64916a690dfb7ee1b7113aa56fbfc972fe7bce985f512ff2e42c',
 independent_expression_basis_sha256:'dc5b27c4153b7af9e719c052be47189e7c5ebc46655b2b0a5ba14d71f449a375',
 independent_expression_probe_sha256:'030b55bd212ac90486527083a60e0952b07ac1e4918fba60c3a9c3f52a1cc561',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'0b8d62a67ddc14c07321b1c9e019b83d6d104f87a8878a2e36bb5f201fad0388',
 source_expected_vector_canonical_sha256:'75190443878862e88b911b43ff11f0ca979e9004434d9edde7a909138c433e41',
 source_expected_vector_gzip_sha256:'63244009f50abd2db10cf4c8ce909b431d2b008e161d19026b31d1bb4a87a052',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'cd45b7ee06e27d33e034013461e2eb3da5677ecffd1adc9a07d6b92c810b28fb',
});
/** Historical14a candidate: C10 rejected ambiguous SQL column before seal/Native. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V15_BEFORE_ALIAS=freeze({
 candidate_sha256:'14a85ee7081d6f3d47a08432f25db99c19a0d1113874f441775c0e01d2bb0ba8',candidate_bytes:3568163,
 independent_expression_leaves_sha256:'181221b8e760554670e21dcd43bbaa6736bb8329ec3fc941564c63c996753f00',
 independent_expression_basis_sha256:'2604e46259e2662d8f67c6220155514deb33b698f96797170d660a4ea442ab1a',
 independent_expression_probe_sha256:'4aa2e9460aa718dc30663525259a20487ba67a3782d6caed7088851c0d7744d3',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'fd781023c640ae9ac294ef0102dc34da857ee553bebaaaa81b2373bdeb76437f',
 // Published VECTOR17 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current15 checks.
 source_expected_vector_canonical_sha256:'2d8af2db3b7089588ac9ec9753af3dc88bc3c3cd34574a099e33711d23fafb03',
 source_expected_vector_gzip_sha256:'dbab62bc1458cc187e8065c3b28201bae6fb0d0c56f8e2bf178f725171c3a9f4',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'7ed9004dd06331baf8c079cda926a5a0da7cc813ea18a91e06c71eac9b72f248',
});
/** Historical C11/C12 source expectation before the financial successor. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V15_BEFORE_FINANCIAL=freeze({
 candidate_sha256:'139e2da7a404202ba7398f9c25040c675ed6dd26caecbedd24ef0069c13376f5',candidate_bytes:3568271,
 independent_expression_leaves_sha256:'15965d6057712f25da2e76129ba9f330e438abdecf1394a5c8fc0ed274af954d',
 independent_expression_basis_sha256:'05e6eaaff51002a77127214c873dce097d8d7454fc0afd9794d90ca64b94ed1c',
 independent_expression_probe_sha256:'397a0629613609ca83d0a922ee5798dfca27679fa554e797c7b9f2250bcde7c9',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'afbf680894aaa49ce427087a3a0dba73b445543126ee826a9e085979f5e0cfe6',
 // Published VECTOR18 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current15 checks.
 source_expected_vector_canonical_sha256:'bd91867d55ba24aa72541e2a2714eb7547a3ba9b9ab245a18817d41cf115738b',
 source_expected_vector_gzip_sha256:'b5c9f4138a098fb3fc898d735cdd122aaf8e740996f9aaf83da1fca3f2b2b2a1',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'49d035f576224ec405bbeff14be545ec70ee898b3c9dcf2bdc4ef9472ee16631',
});
/** Historical Source16 expectation; never admits Source20. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V16_BEFORE_HISTORY=freeze({
 candidate_sha256:'69b366874e24053852339bd192762f7878c9c2bb57a9f2b0beabd3af3ed216fe',candidate_bytes:4639523,
 independent_expression_leaves_sha256:'448db332a5602c5543fa3bc4852c2dfc718221e4634b7cdef06b9965d3a62b84',
 independent_expression_basis_sha256:'37171597b8692244aab42f389d60ef3015325545e533032aec84442de9f49adb',
 independent_expression_probe_sha256:'1d23351fe87e6c685a0fa8d919cc6fd2560fd7c896da027e60f39a3c96399b3e',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'7ed658b3fc26f92e4b52f8986ada3c0a0b90933f4d29f92bf99a7b5d71f434a7',
 // Published VECTOR19 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current16 checks.
 source_expected_vector_canonical_sha256:'eb28975eeebb8880e74a9acf5efe36619413e3b6011e78804247a8e1481bfde9',
 source_expected_vector_gzip_sha256:'0a0c84bee180f8ecdb5f3a591eec6ae985f32586c3863b9284f759610c2f95bf',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'76f093cf22d4171c875f6330b094c9860d0a2da47ed7a33df378b9843495d99e',
});
/** Historical Source20 expectation before direct family ports; never admits Source21. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V20_BEFORE_FAMILY_PORTS=freeze({
 candidate_sha256:'442556de0fb012ac9d63a464b1bfca1b4fa37483a32c8250993acc7a9310e5b8',candidate_bytes:4673025,
 independent_expression_leaves_sha256:'470f0a5bc7d785b042e097583246f37db23e841565c1d6037ece6497d3aab72c',
 independent_expression_basis_sha256:'1091b8cb27868081f917af0e06361e37cc188eed421423930b5d790c9be14561',
 independent_expression_probe_sha256:'559c30be9f91c7655e2c14a8cdc7e6b5300ef6cc37fc66c4c8a383959997b4f5',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'5c0376f0546761f13d230ffd8306977c64f1487bc5a869c302f5726caea8e19b',
 // Published VECTOR20 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current20 checks.
 source_expected_vector_canonical_sha256:'f796f8927861525144a0ec20b373d387d3c42ab5b0b958d6b21cc24fe8fba630',
 source_expected_vector_gzip_sha256:'f8704ea5f0f39df36bad8fabaef92949c62cfe93af020a4684c62bd7bdcf7bb6',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'1bcf56e6e38990de45eed86881b140e830daa77f0cdcc46d89821125104b76f4',
});
/** Historical Source21 before the credit successor; cannot admit Source22. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V20_BEFORE_CREDIT=freeze({
 candidate_sha256:'d6fa6a3d7cf6fbeb0333e2e16d8d59a28cf87249151293a533fab28ef597c951',candidate_bytes:4674391,
 independent_expression_leaves_sha256:'bafdc6f67731e2ffafd0faf52971231acccfbd3c8c1c8f9f52f8957412894ff6',
 independent_expression_basis_sha256:'19ee35f63f36fe61a63efa559bf6882c9fa7e8897b7501f58475f80d7ce20ef9',
 independent_expression_probe_sha256:'c02a7f5bd2ac81a7c0d1e95b30b20211291283aaac9fbe6342659176db018b9d',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'def3cbc39478e774768de9f23c1ff65bd4760440ab6886f574a0e3688645137d',
 // Published VECTOR21 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current20 checks.
 source_expected_vector_canonical_sha256:'8968b09d2f775e831e388b78dee18d2e9e9ec1db52fb6149565785a8d25cc300',
 source_expected_vector_gzip_sha256:'aebab8c9b0f280f16d79bfb43e79ea47558fa6d6e2c100be0f148b92dcbfb870',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'76fba9a5535c788b4c2afded01155198e82d872b2e54bd12e35df1455505c133',
});
/** Historical Source22 before the manual-projection successor; never current admission. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V21_BEFORE_MANUAL_PROJECTION=freeze({
 candidate_sha256:'9e3ba852a350877d4d2106c7d794a29f236dd4794b4ef00d41fd15a6a0e5fe52',candidate_bytes:4761964,
 independent_expression_leaves_sha256:'9dba8c85fd412a3d2639d4004348a47222d1085af36e47671fa50875e64301fd',
 independent_expression_basis_sha256:'506c6905c39074ede16b24c1602b670001f354fbf045b0905c6911f2bc5a26fb',
 independent_expression_probe_sha256:'c3b9e98e23c8d8f23482ebadd7f75a2b05659fd859a3e6ccf8c4eda11d3dc1ad',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'d278c5c28f5fc83b1edb5a91c437f0abbc96750d589a892500eb123d9df407dd',
 // Published VECTOR22 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current21 checks.
 source_expected_vector_canonical_sha256:'476dd5601335c1875854abd8065f63fc9d5dd9638ba1db652fd2d4125d3cb766',
 source_expected_vector_gzip_sha256:'9ef39ca65e0531fd2c72c47ebe7913bd1d43d29d017fbb43f25045d9019e67f0',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'88a1c34699a3c30f6f8d6f50f629b81b338c356d75093ffb256f86b64f5ef48e',
});
/** Historical Source23 before financial statement sharing; never current admission. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_FINANCIAL_SHARING=freeze({
 candidate_sha256:'0d461821282c632455e573a7a277c1ecbf05da24c8e0fe214308d16d9efab9f1',candidate_bytes:5090619,
 independent_expression_leaves_sha256:'bbc785a296b164f6b6863a92617ec2e534db06b7cbf1313eb321672a23e450d0',
 independent_expression_basis_sha256:'919c36774d3bb8bad5ac05dff88763463a3e1cc6faafe5ac482750a9621356a5',
 independent_expression_probe_sha256:'1f7c07be898dccaa7eba4e1c060c129ec4e5908c4f388ec909e26949bf8cf8aa',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'cc23de559208b70d2e9bad6364c5880cc05f2e90eeccbdbe758fced864e5c688',
 // Published VECTOR23 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'e7a6eabd9ce8d384af27bfe17d68924e2c650ba417770d2b711d2aff43c912bb',
 source_expected_vector_gzip_sha256:'0401fe20e9c6df752e661edb21fdb29ae6b906aeccd12e92ce4f06ed2fa52fb7',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'9f38207ae6de15caed98976b7f13cfc516805fa8198ff80e88c8848dc5796cee',
});
/** Historical Source24 before invocation-local metadata traversal. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_METADATA_TRAVERSAL=freeze({
 candidate_sha256:'59bafbea5dabb4e8ccd65139d9075f5433be252545971c04a9f0d0cc226ba2d7',candidate_bytes:5093221,
 independent_expression_leaves_sha256:'010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93',
 independent_expression_basis_sha256:'e7e4cda8de517e52828af1818fa48dbabdd2385cf17b8dca641ac496eacbc0b8',
 independent_expression_probe_sha256:'05b2261e62769774ca95dacd7b0948519c78b7e79916fc2d0c9b785cd932077a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'7588510327377f8056b9f15af79745d9da4c5f3dd158b8a1f0f99f6297d0b42e',
 // Published VECTOR24 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'41c9f44f255c3626bda1cdb88a2b2d65dd1f70ab834639980c68c01fccdf1b58',
 source_expected_vector_gzip_sha256:'77ee6e1eb03d33e46f118286162cd17d9dd55a772f308b5eb476b709a52679b3',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'a5318b4329702c334878c13ebbd1dd50b0717552ec9ec04fc025a10d3c9177a7',
});
/** Historical Source25 before current-node text sharing; never current admission. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_METADATA_TEXT=freeze({
 candidate_sha256:'d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3',candidate_bytes:5095544,
 independent_expression_leaves_sha256:'010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93',
 independent_expression_basis_sha256:'55046033702d88e12b0b8359c8126acd720b42306227e1b73535454146d9c6c8',
 independent_expression_probe_sha256:'05b2261e62769774ca95dacd7b0948519c78b7e79916fc2d0c9b785cd932077a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'de18980e00ac3b18430bb81f651007f89fc848ded3ce3077b152523b4c7fff81',
 // Published VECTOR25 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'0d59d1085d6f269afac999adad9fab3ff36f47a08829d263c5da17b3d71b3b56',
 source_expected_vector_gzip_sha256:'a6889966939eaeca5d4b27dec4c5394777c9e6ea9036cdf0779cd759e332b89c',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'e0ef7929ff69da64e1b9e65cd02f8d301ae124838cc80ff4793ec97173198d15',
});
/** Historical Source26 before exact metadata candidate filtering; never current admission. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_METADATA_CANDIDATE_FILTER=freeze({
 candidate_sha256:'082e4bed0cf507ceb12c9e351f97fe54c051bf9e332da50546e71f124bcc621a',candidate_bytes:5095667,
 independent_expression_leaves_sha256:'010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93',
 independent_expression_basis_sha256:'28e3eafba9fd28c37df4a35c7a6d2dfe7944fbb0a4659c65f98cbedc566ec6d9',
 independent_expression_probe_sha256:'05b2261e62769774ca95dacd7b0948519c78b7e79916fc2d0c9b785cd932077a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'beb0c531e3fd2ac3ef5ecfd864e554bde650b7c7c83dae1a173509054300a365',
 // Published VECTOR26 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'b336aea5299585985e39a3025727685ba61e15bb254aa226b84538d82bf24a0e',
 source_expected_vector_gzip_sha256:'39ce117f86cbb6abddf89d24aaa67853e3eb12ca60bad787dfd81877c625957a',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'849c1feb631f79b1d8fea65ef069d16e245751e783470b2f5ec8e316498a5e0a',
});
/** Historical complete Source27 proof, before same-statement guard reads.
 * Same22 and same47 are legitimate; its old full24 valid record is refused. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_VALID_SNAPSHOT=freeze({
 candidate_sha256:'eeb5034d0d26766f4548a895e3a23b9ae2ab9ad7854215583e8995d9a218c6e3',candidate_bytes:5096180,
 independent_expression_leaves_sha256:'010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93',
 independent_expression_basis_sha256:'3394b1ba07444d288a2a299ce4c67a348b179a3c6a6aeb085816331781b988ce',
 independent_expression_probe_sha256:'05b2261e62769774ca95dacd7b0948519c78b7e79916fc2d0c9b785cd932077a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'cf33fe3aaeceadd4454c46f32961946e77410d92a1b538d680c196c9deb8e616',
 // Published VECTOR27 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'08127853acbf4f976ca1eb0e3b838affb79f75343a42625d68be838d08432130',
 source_expected_vector_gzip_sha256:'a1740b25e4ca292c6ce74cbc50f2cf3bc204e5c402d5e7e515976f9926b18b13',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'dbe676ffab9589d76d26b9ca2ae418823aa50623f9253263e6c9ee6025f7e229',
});
/** Historical complete Source28 proof before metadata snapshot reuse.
 * Its unchanged22 roster cannot authorize Source29 DATA or either new CHECK. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_METADATA_FRESH_MAP=freeze({
 candidate_sha256:'0efeb7fab0521edd3e4130930750482722548e52c32dc553b3787c4774673766',candidate_bytes:5096765,
 independent_expression_leaves_sha256:'010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93',
 independent_expression_basis_sha256:'681266efceaa0b9af6966693dcfeb92afc51bafe5b4160287932aabb6700d894',
 independent_expression_probe_sha256:'05b2261e62769774ca95dacd7b0948519c78b7e79916fc2d0c9b785cd932077a',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'f0b98cc7ec3e860f09dba45368c474d8e807a7845d35ebdfde5c86ad51bf1874',
 // Published VECTOR28 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'01b5bb22cb11877c0660cc60df4f988b743ec5f4e211d568d89240289de43924',
 source_expected_vector_gzip_sha256:'21d960ec9c29b4319c8b754dfc041a3326fb7ca95376eaa41920b86fbfab47af',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'dfb0c6661af2ea21d29dfadcdb25f0f9565d6ac6746ec76bedbcafbce9340722',
});
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_TRIGGER_CONSTRAINT_MAP=freeze({
 candidate_sha256:'bd61089c06f26c9195f5fd002b22424dab8e36dad37580b4cc9c9e259d200bb7',candidate_bytes:5094543,
 independent_expression_leaves_sha256:'2d46f6c06e2aaec3f50624bc582ce7c3d5f5a949ac744bcc96f79f2372cec7ba',
 independent_expression_basis_sha256:'95e8eae518a14bcd9d71917be52e862cdcfa3f4cffc48a5d5f40f0d009409b24',
 independent_expression_probe_sha256:'ef80e240130cd2eebc7f3cb06d89653d9a56b1cf87037161457f05adeacbf496',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'36845e808ef58e0e481a65d71ad4c38b5b78ae2df0d262653f580d353ed42c67',
 // Published VECTOR29 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'55154ca75a4aa2abe9054c051c2fd17cb7860b74ae042c960b948792c6c429f2',
 source_expected_vector_gzip_sha256:'8f2ba2f66a4c0bc4ff389ad1602836e4112e36ba8b962fbf979e4714ac61d1cc',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'199fdfe41aba9511d41793f4590dce2346a855db4c50914f8c81aa180764fab2',
});
/** Complete Source30 source-expectation proof, before metadata composite and lossless definition codec. Historical only. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_COMPOSITE_CODEC=freeze({
 candidate_sha256:'f2f3d9cf78724bc173a3fca1afee4c8b887c1b5bf7b7d5041eeb720c77530c3a',candidate_bytes:5094845,
 independent_expression_leaves_sha256:'2d46f6c06e2aaec3f50624bc582ce7c3d5f5a949ac744bcc96f79f2372cec7ba',
 independent_expression_basis_sha256:'95e8eae518a14bcd9d71917be52e862cdcfa3f4cffc48a5d5f40f0d009409b24',
 independent_expression_probe_sha256:'ef80e240130cd2eebc7f3cb06d89653d9a56b1cf87037161457f05adeacbf496',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'36845e808ef58e0e481a65d71ad4c38b5b78ae2df0d262653f580d353ed42c67',
 // Published VECTOR30 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'ebbe874a4c9edd42f0099c75c856cdacfa637c8a261a220619a736603bf1f136',
 source_expected_vector_gzip_sha256:'13464fcb80007fa21ab0361c5eedaabc17d64db5b7e3e8d2c4bf9f46cac77604',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'5ca2ac87aaa3c11423e898694e322fa3f509cbea647eaf508e6f15e97a61e564',
});
/** Historical complete Source31 proof before the appended schema scalar. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_FRAME_SCHEMA_COLUMN=freeze({
 candidate_sha256:'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab',candidate_bytes:4524547,
 independent_expression_leaves_sha256:'eba71c20f63e1c6935aa2a8309073c9649a2e28858d35a26f2daf1585c2eda85',
 independent_expression_basis_sha256:'12cc0b52508436bddf8633d5c012f08dd3987570b0779580ceb4a6010d2e5bb1',
 independent_expression_probe_sha256:'13a717d9a67551e18c59110350168594e32940dce02dd8a5f680a880250601fa',
 independent_expression_readback_sha256:'a51b4d20866fa49925e64937dd25715b0820569657974d9b9195223cfa3675aa',
 independent_expression_receipt_sha256:'a4fd5b660718ee9a2efe985715884b82b64d4c2b44e6300d99d8a3873426ab3d',
 // Published VECTOR31 is a source expectation only. These fields do not replace
 // full493 source validation, the independent47 pin, or fresh current22 checks.
 source_expected_vector_canonical_sha256:'2d13ca57c395334787ced7a653b8dcfcd3af09d64996852c0a3afaab32bc1316',
 source_expected_vector_gzip_sha256:'58d86a31b14b4ff236d131331fc0370df1ac270d8f6fe186c30e9120de6ecb5e',
 // Source-expectation publication result ONLY; no compiled/inverse/Native claim.
 source_expected_review_sha256:'a9a653f3366200e0b746b46d59755e0fb48f8415d3c01a6d58f1c24d26010697',
});
/** Source32: independently measured P24 expressions and source-only V32.
 * Full compilation, Native and application activation remain separate gates. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_PREFIX_NAME_RANGES=freeze({
 "candidate_sha256": "a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b",
 "candidate_bytes": 4524613,
 "independent_expression_leaves_sha256": "23b6b2ac26b1c6232bb2fa7941288ee4e23e2ea532c245f55d9e2893713a07c6",
 "independent_expression_basis_sha256": "aa361e192fb32f9826c32281c5ec9afd9bf33cead66727aa3f603a11055cf3c3",
 "independent_expression_probe_sha256": "f2458b77241c0ee1a594512672631023e9e070e466b51b5ef95ae218156e140a",
 "independent_expression_readback_sha256": "97a4e3542b1c26549c4c5adf0d21443420519f75cd4787f97738f502f340326f",
 "independent_expression_receipt_sha256": "8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace",
 "source_expected_vector_canonical_sha256": "ffd25373cad501603ea8bd08521a75a8c50d4693dc27bac305eea8902f27dc7e",
 "source_expected_vector_gzip_sha256": "770000ca79bbab659efa37b754d990395024ee85e80359f0afefaec933316392",
 "source_expected_review_sha256": "949e51117690bbecf36793f2d2b97f03fe05550c6a78e7e1a0959f6e65e70b67"
});
/** Source33: whole P24 probe equality reuses the original actual P24 expressions.
 * Source-only V33 adds six NAME/C prefix ranges; no new PostgreSQL probe.
 * Full compilation, Native and application activation remain separate gates. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE_V22_BEFORE_CONSTRAINT_CANDIDATES=freeze({
 "candidate_sha256": "23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d",
 "candidate_bytes": 4525227,
 "independent_expression_leaves_sha256": "23b6b2ac26b1c6232bb2fa7941288ee4e23e2ea532c245f55d9e2893713a07c6",
 "independent_expression_basis_sha256": "aa361e192fb32f9826c32281c5ec9afd9bf33cead66727aa3f603a11055cf3c3",
 "independent_expression_probe_sha256": "f2458b77241c0ee1a594512672631023e9e070e466b51b5ef95ae218156e140a",
 "independent_expression_readback_sha256": "97a4e3542b1c26549c4c5adf0d21443420519f75cd4787f97738f502f340326f",
 "independent_expression_receipt_sha256": "8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace",
 "source_expected_vector_canonical_sha256": "a46053d1f8a62dd0eaba255c617817475ac2d371df0fd473dd2e7475369a1d4a",
 "source_expected_vector_gzip_sha256": "35d9eb87e6dd69562949312b93cc7a4b0400ac7f63d65b1e08979cc0a8950de1",
 "source_expected_review_sha256": "55972fe5d5c97757e145c3523f00b76ceefb2cd4275f71cd6b7a0c6e73caa072"
});
/** Source34: whole P24 probe equality again reuses the original actual P24 expressions.
 * Source-only V34 selects valid() constraints through two catalogue-OID branches; no new PostgreSQL probe.
 * Full compilation, Native and application activation remain separate gates. */
export const ORDER_SPLIT210_FIXED_SEAL_SOURCE=freeze({
 "candidate_sha256": "685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73",
 "candidate_bytes": 4525572,
 "independent_expression_leaves_sha256": "23b6b2ac26b1c6232bb2fa7941288ee4e23e2ea532c245f55d9e2893713a07c6",
 "independent_expression_basis_sha256": "aa361e192fb32f9826c32281c5ec9afd9bf33cead66727aa3f603a11055cf3c3",
 "independent_expression_probe_sha256": "f2458b77241c0ee1a594512672631023e9e070e466b51b5ef95ae218156e140a",
 "independent_expression_readback_sha256": "97a4e3542b1c26549c4c5adf0d21443420519f75cd4787f97738f502f340326f",
 "independent_expression_receipt_sha256": "8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace",
 "source_expected_vector_canonical_sha256": "cbe9a4819d11454443422879b851636c51e7ae7108677b5d24a48b172a502b32",
 "source_expected_vector_gzip_sha256": "0143a44ace2ff5eac97ccb39283e63879198c8092ef60b56b3c0561d6d14c9a9",
 "source_expected_review_sha256": "d2331ae7670065ddad12e0c07fc59e9d738cd1d93556d3481ce9c6ca0225c575"
});
function capture(v,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=1000000&&depth<=64,'fixed-seal JSON bounds');
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='number'){assert(Number.isFinite(v),'finite JSON required');return v;}
 if(typeof v==='string'){
  const n=Buffer.byteLength(v);assert(n<=8388608,'8MiB scalar bound');budget.bytes+=n;assert(budget.bytes<=67108864,'64MiB JSON byte bound');
  assert.equal(Buffer.from(v,'utf8').toString('utf8'),v,'valid UTF8 required');assert(!v.includes('\0'),'JSONB cannot contain NUL');return v;
 }
 assert(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'plain JSON data required');
 const array=Array.isArray(v),ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v),out=array?[]:{};
 assert(keys.every(k=>typeof k==='string'),'no symbol properties');if(array)assert(keys.length===v.length+1&&v.length<=1000000,'dense bounded arrays required');
 for(const k of keys){if(array&&k==='length')continue;if(array)assert(/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length);
  assert(Object.hasOwn(ds[k],'value')&&ds[k].enumerable,'data properties only');budget.bytes+=Buffer.byteLength(k)+3;assert(budget.bytes<=67108864);
  Object.defineProperty(out,k,{value:capture(ds[k].value,depth+1,budget),enumerable:true,writable:true,configurable:true});}
 return out;
}
function json(v){
 const text=JSON.stringify(canonical(v));let prefix='$split210_fixed';while(text.includes(prefix))prefix+='x';const tag=prefix+'$';return tag+text+tag+'::jsonb';
}
const fingerprintExpression=(records,basis)=>"encode(sha256(convert_to(jsonb_build_object('records',"+records+",'basis',"+basis+")::text,'UTF8')),'hex')";
function exactObject(v,fields,label){assert(v&&typeof v==='object'&&!Array.isArray(v),label);assert.deepEqual(Reflect.ownKeys(v).sort(),[...fields].sort(),label+' exact fields');
 const ds=Object.getOwnPropertyDescriptors(v);for(const field of fields)assert(Object.hasOwn(ds[field],'value')&&ds[field].enumerable,label+' data properties only');}

/** Fixed-source authentication is reconstructed on EVERY call. A caller's
 * ready/compiled/schemaValid flag, expected digest or observed catalogue is
 * never accepted. The independent48 leaf pin closes all remaining fields. */
export function deriveOrderSplit210FixedSealBasis(options){
 exactObject(options,['inputs','expectedAdditions','expectedChanges'],'fixed seal source input');
 const{inputs,expectedAdditions,expectedChanges}=options;
 const additions=capture(expectedAdditions),changes=capture(expectedChanges),program=assembleOrderSplit210Source(inputs),closure=deriveOrderSplit210Closure(inputs);
 assert.equal(program.sha256,ORDER_SPLIT210_FIXED_SEAL_SOURCE.candidate_sha256);assert.equal(program.bytes,ORDER_SPLIT210_FIXED_SEAL_SOURCE.candidate_bytes);
 assertOrderSplit210AdditionSemantics(additions,inputs);assert.equal(additions.length,494);
 assert.deepEqual(canonical(changes),canonical(program.changed_functions),'all twenty-two complete source BEFORE/AFTER descriptors');
 assert.equal(changes.length,22);
 for(const field of ['independent_expression_leaves_sha256','independent_expression_probe_sha256','independent_expression_readback_sha256','independent_expression_receipt_sha256'])assert(/^[a-f0-9]{64}$/.test(ORDER_SPLIT210_FIXED_SEAL_SOURCE[field]??''),'fixed twenty-two source expression proof pending: '+field);
 const oracle=deriveOrderSplit210AdditionOracle(inputs),probe=deriveOrderSplit210ExpressionProbe(inputs),map=new Map(additions.map(r=>[identity(r),r]));
 assert.equal(probe.sql_sha256,ORDER_SPLIT210_FIXED_SEAL_SOURCE.independent_expression_probe_sha256);
 assert.equal(probe.readback_sha256,ORDER_SPLIT210_FIXED_SEAL_SOURCE.independent_expression_readback_sha256);
 const leaves=probe.targets.map(t=>{const value=map.get(identity(t))?.value[t.field];assert.equal(typeof value,'string','complete source-compiled expression leaf');return {...t,value};});
 assert.equal(leaves.length,48);assert.equal(digest(leaves),ORDER_SPLIT210_FIXED_SEAL_SOURCE.independent_expression_leaves_sha256,'exact independently source-compiled48 expressions');
 for(const r of oracle.records)assert(r.unresolved_fields.every(f=>probe.targets.some(t=>identity(t)===identity(r)&&t.field===f)),'no unresolved source field outside fixed48 proof');
 const records=sorted([...additions,...changes.map(c=>({kind:c.kind,key:c.key,value:c.after}))].map(r=>r.kind==='function'?{...r,value:orderSplit210TaggedDescriptor(r.value)}:r));
 assert.equal(records.length,516);assert.equal(new Set(records.map(identity)).size,516);
 const after=sorted(changes.map(c=>({kind:c.kind,key:c.key,value:orderSplit210TaggedDescriptor(c.after)})));
 const externalKeys=closure.required_fixed_seal.external_keys,external=sorted(additions.filter(r=>externalKeys.includes(r.key)));
 assert.equal(external.length,36);assert(external.every(r=>r.kind==='trigger'));
 assert.deepEqual(external.map(r=>r.key).sort(),[...externalKeys].sort(),'complete source-authored external36');
 const basis={count:1,bytes:program.projection_basis.bytes,sha:program.projection_basis.sha256};
 const expression=fingerprintExpression(json(records),json(basis));
 return freeze({schema:'order-split210-source-fixed-seal-basis/v1',candidate:{sha256:program.sha256,bytes:program.bytes},source_proofs:ORDER_SPLIT210_FIXED_SEAL_SOURCE,
  records,basis,after,external_records:external,fingerprint_query:'SELECT '+expression+' AS fingerprint',fingerprint_input_sha256:digest({records,basis}),
  metadata_queries:closure.metadata_queries,reader_context:oracle.reader_context,reader_context_verified:false,
  expected_counts:{source_additions:494,replacements:22,fingerprint_records:516,external_records:36,independent_expression_leaves:48},
  fingerprint_from_live_catalogue:false,seal_sql_emitted:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}

/** Parent values MUST be the compiler owner's genuine BEFORE-any210-DDL
 * captures after accepted-parent full gates. They contain per-install birth
 * timestamps and are immutable DATA, not source expectations. The caller must
 * also preserve/check all28 historical certificates before/after installation.
 * No additional TEMP DDL, trust boolean or public runtime API is introduced. */
export function deriveOrderSplit210FixedSeal(options){
 exactObject(options,['inputs','expectedAdditions','expectedChanges','parent209','parent166'],'fixed seal install input');
 const{inputs,expectedAdditions,expectedChanges,parent209,parent166}=options;
 const source=deriveOrderSplit210FixedSealBasis({inputs,expectedAdditions,expectedChanges}),p209=capture(parent209),p166=capture(parent166);
 exactObject(p209,['id','profile','original166','constraints','fingerprint'],'captured parent209');
 exactObject(p166,['singleton','profile','fingerprint','predecessor_certificates','installed_at'],'captured parent166');
 assert.equal(p209.id,true);assert.equal(p209.profile,'merge-delivery-inheritance/v1');assert(Array.isArray(p209.constraints)&&p209.constraints.length===4);
 assert.equal(p166.singleton,true);assert.equal(p166.profile,'delivery-sidecar-managed/v1');assert.equal(typeof p166.installed_at,'string');assert(p166.installed_at.length>0);
 assert(p166.predecessor_certificates&&typeof p166.predecessor_certificates==='object'&&!Array.isArray(p166.predecessor_certificates));
 for(const p of[p209,p166])assert(typeof p.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(p.fingerprint),'captured historical fingerprint shape');
 assert.deepEqual(canonical(p209.original166),canonical(p166),'parent209 nested original166 must be exact captured parent166');
 const fixedRecords=json(source.records),fixedBasis=json(source.basis),fixedAfter=json(source.after),fixedExternal=json(source.external_records);
 const body=`
DECLARE
 expected_records jsonb:=${fixedRecords};expected_basis jsonb:=${fixedBasis};
 expected_after jsonb:=${fixedAfter};expected_external jsonb:=${fixedExternal};
 p209 jsonb:=${json(p209)};p166 jsonb:=${json(p166)};
 actual_own jsonb;actual_after jsonb;actual_records jsonb;actual_basis jsonb;actual_external jsonb;
 expected_fingerprint text;actual_fingerprint text;
BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user<>'postgres'
 OR current_setting('server_encoding')<>'UTF8' OR current_setting('TimeZone')<>'UTC'
 OR current_setting('search_path')<>'pg_catalog, public'
 OR current_setting('server_version_num')::integer NOT BETWEEN 180000 AND 189999
 OR NOT EXISTS(SELECT FROM pg_catalog.pg_database WHERE datname=current_database() AND datcollate='C.UTF-8' AND datctype='C.UTF-8' AND datlocprovider='c')
 OR(SELECT count(*) FROM public.order_split210_manifest)<>0
 OR(SELECT count(*) FROM public.order_split210_projection_basis)<>1
 OR(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1
 OR(SELECT count(*) FROM public.buyer_address_manifest)<>1
 OR p209->'original166' IS DISTINCT FROM p166
 OR p209 IS DISTINCT FROM(SELECT to_jsonb(p) FROM public.order_merge_delivery209_manifest p)
 OR p166 IS DISTINCT FROM(SELECT to_jsonb(p) FROM public.buyer_address_manifest p)
 THEN RAISE EXCEPTION 'Split210 fixed source seal parent/context changed' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM public.order_split210_projection_basis WHERE id AND payload IS NOT NULL
  AND payload_octets=${source.basis.bytes} AND payload_sha256='${source.basis.sha}'
  AND payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1')
 THEN RAISE EXCEPTION 'Split210 fixed source basis changed' USING ERRCODE='55000';END IF;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) INTO actual_own FROM(${source.metadata_queries.own}) own_source;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) INTO actual_after FROM(${source.metadata_queries.changed_functions}) current_after;
 IF jsonb_array_length(actual_own)<>494 OR actual_after IS DISTINCT FROM expected_after
 THEN RAISE EXCEPTION 'Split210 fixed full source roster changed' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(v ORDER BY v->>'kind' COLLATE "C",v->>'key' COLLATE "C") INTO actual_records FROM jsonb_array_elements(actual_own||actual_after) v;
 SELECT jsonb_build_object('count',count(*),'bytes',min(payload_octets),'sha',min(payload_sha256)) INTO actual_basis FROM public.order_split210_projection_basis;
 SELECT coalesce(jsonb_agg(v ORDER BY v->>'kind' COLLATE "C",v->>'key' COLLATE "C"),'[]'::jsonb) INTO actual_external FROM jsonb_array_elements(actual_own) v
  WHERE v->>'kind'='trigger' AND EXISTS(SELECT FROM jsonb_array_elements(expected_external) e WHERE e->>'key'=v->>'key');
 expected_fingerprint:=${fingerprintExpression('expected_records','expected_basis')};
 actual_fingerprint:=${fingerprintExpression('actual_records','actual_basis')};
 IF actual_records IS DISTINCT FROM expected_records OR actual_basis IS DISTINCT FROM expected_basis
 OR actual_external IS DISTINCT FROM expected_external OR actual_fingerprint IS DISTINCT FROM expected_fingerprint
 THEN RAISE EXCEPTION 'Split210 complete fixed source fingerprint changed' USING ERRCODE='55000';END IF;
 INSERT INTO public.order_split210_manifest(id,profile,fingerprint,original209,original166,external_records)
 VALUES(true,'order-split210-closure/v1',expected_fingerprint,p209,p166,expected_external);
 IF public.order_split210_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Split210 fixed seal readback refused' USING ERRCODE='55000';END IF;
END;
`;
 let prefix='$split210_fixed_seal';while(body.includes(prefix))prefix+='x';const tag=prefix+'$';
 const sql='-- Separately reviewed FIXED source seal; parent originals are per-install immutable DATA.\nDO '+tag+body+tag+';\n';
 return freeze({schema:'order-split210-source-fixed-seal-program/v1',sql,sha256:sha(sql),bytes:Buffer.byteLength(sql),
  fingerprint_query:source.fingerprint_query,fingerprint_input_sha256:source.fingerprint_input_sha256,
  source_basis:source,parent_data_sha256:{original209:digest(p209),original166:digest(p166)},
  parent_capture_requirements:{before_any_210_ddl:true,accepted_parent_full_gates:true,historical_certificates:28,before_after_exact:true},
  parent_capture_verified:false,seal_sql_emitted:true,seal_executed:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
