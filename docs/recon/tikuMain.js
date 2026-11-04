/**
 * 获取分页数据
 */
function getPageData(data){
     $.ajax({
    	 type:"post",
    	 url:"../../hw/tiku/queryItemBankByPage.do",
    	 data:data,
    	 error:function(result){
    		 layer.msg(result.responseText);
    	 },
    	 success:function(result){
    		 $("#total").text(result.total);
    		 layui.use(['laypage'],function(){
	             var laypage = layui.laypage;
	             laypage({
	                     cont: 'pageBox',
	                     pages: Math.ceil(result.total / data.pageSize), //得到总页数
	                     groups: 3,
	                     curr:data.pageIndex,
	                     skip:true,//设置是否显示调到第几页-默认为false
	                     skin: '#1E9FFF',//设置按钮选中颜色
	                     jump: function (obj,first) {
	                         document.getElementById('pageList').innerHTML = render(result);
	                         if(!first){
	                        	 data.pageIndex = obj.curr;
	                        	 getPageData(data);
	                         }
	                     }
	                 }); 
	             });
    	 }
    	 
     });
}
//渲染pageList
function render (result) {
	console.log(result);
    var arr = []
            , thisData = result.rows;
    layui.each(thisData, function (index,item) {
        arr.push(
        		 '<tr>'+
                 '<td ><a href="javascript:void(0);" onclick="preViewThePaper(\''+item.rec_id+'\');" class="text-primary">'+item.field01+'</a></td>'+
                 '<td >'+item.userName+'</td>'+
                 '<td >'+item.cdate+'</td>'+
                 '<td >'+item.field06+'</td>'+
                 '<td >'+item.paperUsedCount+'</td>'+
                 '<td>'+
                   /*'<button class="btn btn-primary btn-xs mr5" onclick="editPaper(\''+item.rec_id+'\');">编辑</button>'+*/
                   '<button class="btn btn-green btn-xs mr5" onclick="preViewThePaper(\''+item.rec_id+'\');">查看</button>'+
                   '<button class="btn btn-warning btn-xs mr5" onclick="connectKeti(\''+item.rec_id+'\');">关联课题</button>');
        if(item.paperUsedCount == 0)arr.push('<button class="btn btn-danger btn-xs" onclick="delPaper(\''+item.rec_id+'\');">删除</button>');
        
        arr.push(
                 '</td>'+      
                '</tr>'
        );
    });
    return arr.join('');
};


function preViewThePaper(paperId){ 
	window.location.href="../../hw/tiku/preViewThePaper.do?paperId="+paperId; 
}

function connectKeti(paperId){
	window.location.href="../../hw/tiku/connectKeti.do?paperId="+paperId; 
}

function editPaper(paperId){
	alert("这个编辑到底是编辑试卷？还是改编？");
}

function delPaper(paperId){
	var idx = layer.confirm('是否删除该试卷?', {icon: 3, title:'提示'}, function(index){
			$.ajax({
		    	 type:"post",
		    	 url:"../../hw/tiku/deletePaper.do",
		    	 data:{"paperId":paperId},
		    	 error:function(result){
		    		 layer.msg(result.responseText);
		    	 },
		    	 success:function(result){
		    		 //location.href="../question/main.do";
		    		   getPageData(data);
					   layer.close(idx);
		    	 }
		     });
	   });
}
